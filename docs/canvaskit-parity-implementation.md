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
| image effect pixels and crop preprocessing | `rhwp-studio/src/view/image-effect-pixels.ts`; `src/renderer/image_effect.rs` | resource cache, native Skia, and SVG replay use one threshold/dither contract |
| base64 payload decode | `rhwp-studio/src/core/base64.ts` | image resources and portable font-blob registration |
| HWP text replay helpers and PUA projection helpers | `rhwp-studio/src/view/text-replay-utils.ts` | root `TextRun`, special text ops, control marks, overlap text |
| fallback family chains and face-weight hints | `rhwp-studio/src/core/font-family-fallback.ts` | Canvas2D CSS font shorthand and CanvasKit family/style matching |
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
cache keys and CanvasKit static picture cache keys include those sidecar
payloads as well, so cached pictures cannot be reused across different strict
text alternatives. CanvasKit scopes that dependency to sidecars anchored inside
the cached subtree and to the current replay plane; unrelated sidecars do not
discard otherwise reusable pictures. CanvasKit static picture cache keys also
include replay `outputOptions`, because `clipEnabled`, paragraph marks, and
control-code visibility change direct replay without changing node identity.
Visible structure/object labels (`[표]`, `[그림]`, `[글상자]`, `[수식]`,
`[머리말]`, `[꼬리말]`, and `[각주]`) are backend-neutral
`TextControlMark` ops rather than renderer-generated overlays. They are emitted
once inside the owner subtree, text-box labels remain inside the owner clip,
and picture labels copy the image `wrap` value so every replay backend places
the label on the same replay plane as the image. Canvas2D, CanvasKit, SVG, and
native Skia therefore consume the same op and must not synthesize a second
semantic/image/equation label.
Externalized `TextControlMark` and `TabLeader` ops also preserve the owning
`TextRun.rotation` value. The value is expressed in degrees and is applied
around the owner bbox center by Canvas2D, CanvasKit, SVG, and native Skia,
matching the existing externalized `CharOverlap` and `TextDecoration` contract.
Artifacts from older additive schema revisions may omit the field; readers
must interpret an omitted value as zero degrees.
Rust `PageLayerTree` replay-plane subtree detection is now centralized in
`paint/replay_order.rs` as well: native Skia and layer SVG both use the same
helper to skip planes that have no root or sidecar paint for the current
subtree, so static caches and vector output no longer carry backend-local blank
plane traversal policy. CanvasKit mirrors that behavior before recording a
static subtree picture: each replay-plane cache entry is created only when the
subtree contains a root or sidecar paint op for that plane.
Native Skia text replay also prefilters system font family lookups against the
enumerated family list, while preserving generic `serif`, `sans-serif`, and
`monospace` fallback aliases. This keeps headless platforms from handing
obviously missing document font names to platform font lookup before the shared
fallback list is tried.

Browser text fallback now uses one family/weight contract for Canvas2D and
CanvasKit. A weight-suffixed face is tried first, then its base family, then the
same HWP-aware serif/sans/monospace candidates. Explicit `Bold`/`볼드`, Light
family, and 중고딕/태고딕-style names map to the same 700/300/500 hints used by
the Rust renderer; other faces remain weight 400 unless the HWP bold bit is
set. CanvasKit includes the resolved weight in its text fallback and blob cache
keys, requests the matching CanvasKit family style, and synthesizes emboldening
only for a 700 request without a registered 700 face. The lifecycle fixture
verifies that a two-token `Extra Bold` suffix preserves weight 700 across the
primary, currency, and symbol fallback paths while retaining Canvas2D-vs-
CanvasKit fuzzy pixel parity. Rust WebCanvas uses the same requested-face,
base-family, and generic fallback order for rotated text, ordinary runs, and
overlap controls, so its Canvas font string no longer skips the base face for
weight-suffixed families.

The first strict `GlyphOutline` payload subsets are also implemented as
feature-gated direct replay contracts. The current baseline covers
`MonochromeFill`, `MonochromeFillStroke`, `ColorLayers.ColrV0`,
`ColorLayers.ColrV1` stage 1 (`solidPath` plus local `transform`),
`BitmapGlyph` with a single producer-selected image strike, and `SvgGlyph`
with a sanitized static vector resource. Studio Canvas2D/CanvasKit, Rust SVG,
and native Skia now replay the first COLRv1 stage-2 subset:
`linearGradientPath` and `radialGradientPath` leaf nodes with resolved color
stops. Studio Canvas2D/CanvasKit and native Skia also replay the stage-3
`sweepGradientPath` subset for full 360-degree run-local sweep gradients; Rust
SVG keeps this subset in deterministic fallback/reject because SVG has no
portable native conic-gradient primitive. The stage-4 `sourceOver` composite
subset is now implemented as local glyph-payload composition: native Skia,
Rust SVG, Studio Canvas2D/CanvasKit, JSON/JS bridges, cache keys, and the Rust
CanvasKit replay plan all replay or validate the same source/backdrop edges.
Blend modes beyond `sourceOver` remain blocked behind explicit graph
semantics. The first stage-5 subset is also implemented: `clip` graph nodes
apply a run-local path clip to their child, and reusable DAG subgraphs are
accepted as long as graph traversal remains acyclic, reachable from the root,
and inside the graph size/depth limits. Studio Canvas2D/CanvasKit, Rust JSON/JS
bridges, Rust SVG eligibility and output, native Skia, and the Rust CanvasKit
replay plan share the same payload eligibility vocabulary and deterministic
fallback/reject reasons for those subsets.
The browser renderer contract now also pins the strict glyph payload family
exclusivity rules directly: color, bitmap, SVG, and stroke payload families
must not be mixed, and deferred-authority gates for cross-scope variants,
fallback-free strict text, and public `MixedPerGlyph` remain required-feature
guarded.

Dynamic browser verification on 2026-06-03 completed the checked-in full
CanvasKit E2E corpus through `npm run e2e:ci` with
`RHWP_RENDER_SAMPLE_SCOPE=full` and a single replay iteration. Both `compat`
and `default` CanvasKit modes passed against the Canvas2D reference with 137
full-page cases plus 2 feature cases in the `screen` profile. The same run also
completed the software smoke, WebGPU-preferred fallback smoke, and renderer
lifecycle suite. The local headless environment could not create a WebGL
surface and the current CanvasKit bundle reported `CanvasKit WebGPU build
support unavailable`, so CanvasKit fell back to a CanvasKit software surface;
this is an execution-surface fallback, not a Canvas2D replay overlay. The sweep
confirmed direct CanvasKit dispatch for text, images, equations, form objects,
page background images, path/shape primitives, strict color/bitmap/vector
glyph payload probes, resource table/cache invalidation, and text variant
selection diagnostics. It also confirmed that fallback overlay helper methods,
DOM image caches, and equation SVG DOM caches remain removed. Because the run
used one replay iteration, visual parity and dispatch/resource diagnostics are
authoritative for that sweep, while performance guards were intentionally
recorded as metrics only.

Targeted local verification on 2026-06-05 ran
`npm run e2e:render:software:smoke:headless` for the `eq-01` sample. The run
used an explicit CanvasKit software surface, confirmed shared SVG resource
table routing for equation payloads, passed the raster-only equation diff
budgets, and rechecked that text, image, equation, form, path, page-background,
and footnote fallback overlay helpers remain absent. The single-iteration
performance numbers from that smoke remain metrics only.
The same sample also passed `npm run e2e:render:webgpu:smoke:headless` in the
local headless environment. CanvasKit attempted the requested WebGPU surface,
recorded `CanvasKit WebGPU build support unavailable`, recorded the subsequent
WebGL context failure, and then replayed through the CanvasKit software surface
with the same equation resource routing, raster-only diff budgets, and removed
overlay-helper checks. That result keeps WebGPU as an execution preference, not
a correctness dependency.

Full local verification on 2026-06-05 also ran `npm run e2e:headless`. That
suite completed the renderer contract, image diff, font mapping, text flow,
CanvasKit representative compat/default render comparisons, WebGPU-preferred
smoke, forced software smoke, and renderer lifecycle checks. The representative
`default` sweep covered 11 full-page cases plus 2 feature cases; the full-page
average CanvasKit replay ratio was `5.145 <= 15`, and the feature average was
`3.108 <= 15`. The lifecycle checks confirmed the `skia` renderer alias still
normalizes to CanvasKit, Canvas2D overlay methods remain absent, software,
WebGL-preferred, and WebGPU-preferred surface diagnostics are recorded, and
static picture/resource caches invalidate on image, bitmap glyph, SVG glyph,
and ArrayBuffer payload changes. The same session rechecked strict text
variant, GlyphRun, GlyphOutline, COLRv0/COLRv1, BitmapGlyph, SvgGlyph,
image-effect, and CanvasKit cache contracts through the browser contract suite.
GitHub Actions for the current `skia` branch push sequence were green when this
verification was recorded.

Full local browser-profile verification on 2026-06-29 ran the renderer
baseline manifest against Canvas2D, `canvaskit-compat`, and
`canvaskit-default` in all four layered render profiles. The `screen` sweep
compared `214/214` CanvasKit browser outputs and the `fast-preview` sweep also
compared `214/214`, with zero failed, missing, or errored comparisons. The
`print` plus `high-quality` sweep compared another `428/428` CanvasKit browser
outputs, again with zero failed, missing, or errored comparisons. Every target
backend and every category in the representative corpus passed with
`selectedDiffRatio = 0`; the largest tolerant drift remained the existing
sampling/form/HWPX watch class rather than a missing CanvasKit paint branch.
These runs cover the current browser CanvasKit parity target across paragraph,
font, table, image, equation, field, control, form, shape, HWPX, header/footer,
and mixed real-document samples.

A focused 2026-07-29 `hwpspec.hwp` rerun after the shared fractional page
bitmap-boundary correction classified the remaining whole-page 16 by 13 BMP
enlargement difference. Canvas2D and CanvasKit produced identical ink masks,
non-ink masks, and solid-ink masks under the promoted budget. At the previous
default channel tolerance of `8`, only one of `891662` output pixels remained,
and the maximum channel delta was `9`.
The sample is therefore part of the representative manifest with a narrow
`ignoreChannelDelta = 9`, `maxDiffRatio = 0` raster-only budget instead of
remaining an unclassified watch item.

Full default-mode corpus verification on 2026-07-30 covered all 139 full-page
cases plus 2 feature cases in the `screen` profile. The manifest was split by
filename only to avoid concurrent headless-browser resource contention; four
initial startup failures passed when rerun sequentially and were not renderer
gaps. The one reproducible functional defect was `table-004`: the bundled
CanvasKit fonts had no glyphs for the vertical presentation forms `U+FE35` and
`U+FE36`, so they rendered as `.notdef`. CanvasKit now replays the corresponding
base parentheses directly, centers them in the producer-authored vertical
cells, and rotates them on the CanvasKit canvas without a Canvas2D overlay.
`table-004` now passes the geometry and raster-only budgets. The only other
reproducible differences were stable rasterizer deltas in `endnote-01`,
`footnote-01`, and `pr-149`; their ink geometry already matched, so each has a
narrow sample-specific raster-only budget. Targeted sequential reruns of all
four samples pass.

Profile-specific editor visuals are filtered before backend replay. Empty field
guides are marked `editor_only` in the semantic render tree; `LayerBuilder`
keeps them for `screen` and `fast-preview`, and omits them for `print` and
`high-quality`. Canvas2D, CanvasKit, SVG layer replay, and native Skia therefore
consume the same profile-resolved PageLayerTree. Raw profile-unaware legacy SVG
traversal retains its prior screen-style behavior, while the legacy SVG path
used by PDF export receives the print profile and suppresses the same nodes.
CanvasKit replay plans are profile-bound as well: plan JSON records
`renderProfile`, the WASM API accepts an explicit profile, and the browser
baseline rejects a plan whose profile differs from the runtime tree. The older
two-argument plan API remains a screen-profile compatibility entry point only;
non-screen diagnostics fail closed when used with a stale WASM build.

## Upstream Tracking Check (2026-06-12)

The latest upstream check used `upstream/main` at `bc38ff55`,
`upstream/devel` at `4574299f`, issue #536 updated on 2026-06-11, and open
P23 PR #1359 at head `3192efbf`. The upstream plan still matches this branch's
direction: CanvasKit remains an overlay-free direct replay backend, and the
remaining feature families advance through explicit fixture, corpus, proof, or
authority gates rather than hidden Canvas2D/SVG fallback.

The 2026-07-12 `upstream/devel` review imported the three later CanvasKit
changes that still closed real gaps on this branch: ordinary text
superscript/subscript metrics, complex-script paragraph shaping, and the
expanded Noto Sans KR symbol subset used for bullets and box-drawing glyphs.
The browser lifecycle suite now closes the corresponding raster-proof gap with
`canvas-layer-text-script-parity`: it renders normal, superscript, and
subscript ASCII plus superscript Korean, a subscript combining-mark sequence,
and a superscript PUA-expanded display string through Canvas2D and CanvasKit.
Both backends must preserve superscript-before-normal-before-subscript vertical
ordering, produce ink for every complex-script region, and pass the existing
fuzzy PNG comparison. The first Chromium proof passed with `1445` exact,
`801` tolerant, and `289` ink-mask differing pixels over the `244x100` fixture.
The older `unsupportedDirectReplay` equation/raw-SVG diagnostic patch was
intentionally not imported because this branch already directly replays both
operation families; applying it would make the Rust plan disagree with the
runtime again. A broad `devel` merge remains inappropriate because upstream
has already reapplied many `skia` batches under different commits while both
trees continued to evolve independently.

The 2026-07-29 remote `devel` audit selectively ports the verified display
table from upstream `44cabad97` without importing its HWP3 parser, page
background, or layout-specific changes. Eleven Hancom PUA symbols now project
to public-font text only after document/PDF verification, including the
company-name header and Enter pictogram; unknown neighboring PUA remains
unchanged. Rust JSON/WASM emits the projected `displayText`, while the shared
Studio fallback applies the same table when an older tree lacks that field.
The lifecycle fixture feeds raw company-name PUA to both Canvas2D and CanvasKit
and requires visible ink plus fuzzy raster parity.

The later upstream legacy-product correction is applied through this branch's
source/display projection contract instead of importing its
renderer-tree-specific display field. Raw source spellings `ᄒᆞᆫ글`,
`ᄒᆞᆫ메일`, `ᄒᆞᆫ팩스`, and `ᄒᆞᆫ소프트` project to their modern product
spellings for layout metrics and all Canvas2D, SVG, CanvasKit, JSON, and WASM
paint paths. The projection crosses style runs and non-authorial layout-line
splits, including the separate inline-table paragraph path, but does not cross
explicit line breaks, inline-control gaps, char-overlap runs, or footnote
markers.

Raw source text and indexes remain unchanged. Each source character carries a
display fragment; the first three legacy jamo map to `"한"`, `""`, and `""`.
The empty fragments are significant zero-advance normalized clusters, so
partial-run lowering, vertical layout, source selection, and JSON/WASM export
retain source identity without painting duplicate glyphs. `TextRun.text`
continues to carry source text while optional `displayText` carries the visual
projection. Projected runs are excluded from `GlyphRun` and `GlyphOutline`
sidecars until a shaping-equivalent source/display mapping exists, and static
Skia cache keys include the explicit display value. Product matching runs
before PUA old-Hangul expansion, so a PUA sequence that expands to the same
jamo is not misclassified as a product name; ordinary old-Hangul words remain
untouched.

The same shared table also carries ten earlier upstream mappings with
document/PDF or embedded-outline evidence: the corrected basic-PUA middle dot
and right arrow, a supplementary down arrow and middle dot, HWP3 line glyphs,
and Korean book-title brackets. Single-scalar entries also override the legacy
bullet fallback so numbering and body text cannot disagree. The tentative
`U+F00DA` and `U+F0827` guesses remain raw, as do the overlap-only boxed-number
ranges in ordinary text. The browser fixture now covers both BMP and
supplementary-PUA entries through Canvas2D and direct CanvasKit replay.

No broad upstream or `render-p23` cherry-pick should be applied to this `skia`
branch just to stay current. The branches have diverged substantially: this
branch already carries CanvasKit/native Skia parity work that is ahead of
`devel`, while upstream has unrelated layout, serializer, Studio, and PDF API
work. Import only small, contract-relevant commits when they close a current
CanvasKit parity gap or provide a fixture needed by one of the gates below.

The 2026-08-10 follow-up audit checked `upstream/main` at `2dced7bfe` and
`origin/render-p42` at `9138cf3a0`. The P42 fail-closed change `c80b6b6eb`
rejects synthetic styles, bidi metadata, and non-horizontal writing modes
because that narrower branch does not yet prove them. It is intentionally not
cherry-picked wholesale: this branch already has native and browser pixel
proof for bidi-split, vertical-upright, and vertical-sideways strict
`GlyphRun` replay. Instead, the uncovered font-instance mismatch is fixed at
the shared contract boundary. `FontInstanceKey.sizePx` is authoritative in
both native Skia and CanvasKit, and `syntheticBold`/`syntheticItalic` are
materialized through Skia font embolden/skew state in both backends. Native
font-state assertions and CanvasKit raster/fallback-suppression fixtures pin
that behavior. `MixedPerGlyph` and public glyph-transform emission remain
feature-gated until their separate cluster-transform proof exists.

The latest contract audit used `upstream/devel` at `2f281d67f`. Its page-extent
rounding, old-Hangul shaping, page-background tone/opacity, PUA/font-metric, and
resource-prefetch identity changes are already represented here by equivalent
or stricter implementations and tests. The one uncovered rendering semantic
was the mixed-axis master-page coordinate contract from upstream `22459efdd`;
it was ported as `237f9ae32` without importing unrelated parser changes. HWP3
parser commits remain a separate parser-baseline concern because this branch
does not currently contain that parser architecture.

Master-page `Shape` and `Equation` lowering now uses a virtual paragraph/column
area whose horizontal origin and extent come from the page body, while its
vertical origin and extent come from the paper. This keeps horizontal placement
inside body margins without incorrectly adding the top body margin to
paragraph-relative vertical coordinates. `Picture` and `Table` placement retain
their existing contracts. Canvas2D and CanvasKit consume the same lowered
geometry, and the regression fixture asserts the body-relative x coordinate and
paper-relative y coordinate independently.

The tracking issue changes affect this branch as follows:

- P23 is PDF export/native API packaging. PR #1359 adds shared
  `DocumentCore` native PDF export APIs, routes CLI `export-pdf` through that
  API, and adds report-only PDF visual diff artifacts. This is useful for
  future native/vector export alignment, but it is not a prerequisite for
  CanvasKit-vs-Canvas2D web parity. The current `skia` branch already keeps PDF
  artifact collection/reporting as non-hard-gate support work; do not mix the
  full P23 API surface into CanvasKit replay commits unless the native export
  API itself becomes the task.
- P24 remains strict `BitmapGlyph`/`SvgGlyph` producer-output corpus widening.
  The implementation should add real lowering/resource-path fixtures on top of
  the existing one-strike bitmap and sanitized static vector contracts, not
  reopen payload semantics or writer gates.
- P25 remains exact font replay corpus widening. Native Skia may widen through
  real variable-font and TTC/OTC fixtures. Native Skia now has a digest-pinned
  two-face TTC whose second face contains a unique outline. CanvasKit now uses
  the same fixture to prove bounded exact face extraction into a standalone
  SFNT; explicit variation tuples still keep `variationUnsupported` until a
  browser-side exact instance construction proof exists.
- P26 remains authority-gated v2 follow-up work. Additional COLRv1 primitives,
  shapedModern width input/line breaking, cross-scope variants, and public
  `MixedPerGlyph` writer emission stay blocked until their concrete
  document/use-case gates are satisfied.

Recent upstream `devel` fixes that matter to renderer planning are treated as
baseline assumptions, not as automatic cherry-picks:

- #1349 HWPX picture effects shadow roundtrip preservation can affect future
  object/image replay fixtures. CanvasKit work should preserve effect metadata
  and diagnostics, but should not hide unsupported effects with overlay paint.
- #1351 `useFontSpace` preservation can affect text/font serialization
  baselines. It is not a reason to turn on shapedModern measurement or layout
  mutation.
- #1354 equation PUA conditional bar mapping can affect equation/text replay
  comparisons. Treat it as input normalization baseline when adding equation
  fixtures.
- `origin/render-p23` also contains #1378/#1379/#1380 HWPX roundtrip and
  serializer preservation work. Those changes are useful for future corpus
  quality, but they are not CanvasKit parity implementation commits unless a
  specific fixture proves a renderer-visible gap.

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
   TextRun warm replay also caches the resolved fallback family by primary
   family, style, fallback class, and text cluster. The bounded cache stores
   family names only; CanvasKit font/typeface objects remain render-owned and
   are released after each run. Admitted raster images first use CanvasKit's
   synchronous encoded-image codec. When that codec rejects an otherwise
   bounded PNG, JPEG, BMP, or structurally proven single-frame GIF/WebP,
   Studio uses the browser image decoder
   asynchronously and converts the decoded source directly into a CanvasKit
   `Image`; it never composites the recovery through Canvas2D. Static pictures
   are not admitted while that resource is pending. Successful browser-decoder
   recovery remains visible in `CanvasKitImageDiagnostics` on later cache hits.
   GIF recovery requires a complete stream with exactly one image descriptor
   and a terminal trailer. WebP recovery requires a complete RIFF chunk walk,
   one VP8/VP8L image payload, no animation feature flag, and no `ANIM`/`ANMF`
   chunk. Animated or structurally incomplete GIF/WebP stays on CanvasKit's
   synchronous codec path, so a codec failure remains a deterministic final
   decode failure rather than selecting a timing-dependent browser frame.
   Only failure of both decode paths is contained as an unavailable resource and
   negative-cached by resource identity until that resource table is replaced.
   Missing resources, invalid base64, rejected encoded-image headers/limits,
   successful browser recoveries, and final decode failures therefore remain
   distinct instead of becoming silent paint omissions. Image-effect
   preprocessing normally uses a CanvasKit offscreen surface so fractional
   crop sampling retains Skia semantics. If that surface cannot be created,
   an integer-aligned, in-bounds source rectangle is read directly from the
   CanvasKit `Image`, transformed by the shared pixel-effect implementation,
   and rebuilt as a CanvasKit `Image`. Fractional or scaled source rectangles
   are not approximated by this recovery path. Successful recoveries increment
   `directImageReadbackPreprocesses` and remain visible in the browser baseline
   without being classified as replay failures. TextBlob construction
   failures are negative-cached without dropping the affected cluster.
   CanvasKit retries that cluster through direct `drawText`, which reaches
   `_drawSimpleText` without constructing a public `TextBlob`. A successful
   retry is reported as a text replay recovery; only failure of both paths is a
   runtime text replay failure. Neither diagnostic exposes cluster text:
   diagnostics retain only the op identity, resolved family, and UTF-16 cluster
   range. Pattern tiles normally use a 6-by-6 CanvasKit surface. If that surface
   is unavailable, the same integer row, column, and diagonal masks are
   source-over composited into an unpremultiplied RGBA buffer and passed to
   CanvasKit `MakeImage`; the browser fixture requires exact pixels for
   semi-transparent colors, including the double-painted cross intersection.
   `directImageCreations` reports this successful native-ready recovery. A
   cached failure of both pattern paths is re-reported on every attempted replay
   rather than looking like a successful cache hit. Failed pattern images are
   retried once at the next render boundary, while successful surface or direct
   images remain cached.
4. Diagnostics explain every selection, rejection, fallback, and cache decision
   that affects faithful replay.

The implementation should keep Canvas2D as a test oracle, not a code
dependency. If CanvasKit behavior intentionally differs because Skia semantics
are stricter or more native-ready, the fixture should label that difference
instead of hiding it behind a Canvas2D overlay.
Equation SVG replay counts as successful only after a parsed path or text layer
actually reaches CanvasKit drawing. If every SVG path fails CanvasKit parsing,
the renderer must use the existing equation layout-box replay instead of
suppressing it with a blank SVG result.
GPU surface failures follow the same rule: CanvasKit may retry with a CanvasKit
software surface, but it must not instantiate Canvas2D as a hidden renderer
fallback.

Studio page replay composes page content and margin guides on the same
CanvasKit surface before one flush. A second guide-only flush is not part of
the normal page path because it makes software-surface cost scale twice with
the page raster size. Static-picture resource keys include the producer table,
resource key/hash, and an actual payload fingerprint only for image, static
SVG, and portable-font resources referenced by the cached subtree's current
replay plane. GlyphRun dependencies follow the exact face to its blob and
payload; schema-v1 sidecars are included only when anchored to a leaf inside the
subtree. Adding or replacing an unrelated document resource therefore leaves
the picture reusable. Payload fingerprints are memoized by resource object
identity so repeated replay does not rescan large byte arrays, while replacing
a referenced resource object still invalidates stale pictures even when
producer metadata is unchanged.
Ordinary document edits invalidate exported page trees and their static
pictures, but retain the document-scoped resource table until a new document
is loaded or the view is disposed. Content-addressed resource interning then
keeps unchanged image, static SVG, and portable font-blob ids stable across
edit refreshes. Decoded CanvasKit images and verified portable font inputs can
therefore remain warm, while changed bytes receive a distinct document resource
id even if a malformed producer reuses a key. Studio rewrites page-local
portable-font `dataRef` values to those document resource ids before replacing
the page resource table. A true document reset immediately cancels pending
image work, releases decoded/effect/mipmap images and verified embedded-font
instances, and detaches the previous tree even when the replacement document
has no renderable page.
The document resource table remains append-only while cached page trees can
refer to it. At an ordinary edit refresh, after every cached page tree and
static picture has been released, Studio starts a new resource generation when
the retained table exceeds 4,096 payloads or 256 MiB of encoded image, static
SVG, and portable font data. Canvas2D and CanvasKit document caches reset in
the same step; visible pages then repopulate the new table. Compaction is not
performed during page traversal, so an unseen page can never lose a resource id
while an older tree remains cached.
The v1 compatibility export advertises additive schema revision `1.22` and
resource-table revision `1.5`. Those revisions cover the implemented advanced
glyph payload gates, split output/build/debug options, externalized bounded text
visuals, explicit structure control-mark ops, owner rotation on externalized
control marks and tab leaders, and image, static-SVG, and portable-font
resources. Schema v2 keeps its own `2.0` envelope while reusing the same `1.5`
resource-table contract.
CanvasKit fallback-font initialization deduplicates bundled Noto/D2/math URLs
and prefetches the remaining unique catalog files in parallel; registration
order and family/style matching remain deterministic.

## Work Phases

### P1. Dependency Boundary Closure

P1 removes CanvasKit dependencies on broad Canvas2D/browser helpers.

Status: complete. Keep the exit criteria below as regression requirements.

Exit criteria:

- `canvaskit-renderer.ts` and `rhwp-studio/src/view/canvaskit/*` do not import
  `canvas2d-layer-renderer` or broad Canvas2D utility modules.
- CanvasKit-visible helper modules are free of `CanvasRenderingContext2D`,
  `Path2D`, `DOMParser`, browser text measurement, and SVG DOM nodes. The one
  bounded adapter exception is `resource-cache.ts`: it may use an image element
  and object URL only to decode an admitted image into
  `MakeImageFromCanvasImageSource`.
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
| gradients and patterns | CanvasKit shaders or deterministic CanvasKit image resources | shared stop-position normalization plus exact surface/direct pattern pixels and no CSS or Canvas2D pattern object dependency |
| images and image fills | encoded resource bytes decoded into CanvasKit images | deterministic resource key, cache diagnostics, and shared effective bbox correction for 90/270 degree image rotations |
| image effects and shadows | CanvasKit image filters, paints, or native-ready pixel preprocessing | no hidden browser pre-pass without a resource contract |
| form and equation objects | direct CanvasKit geometry and text/path drawing | branch parity and fixture for geometry bounds |
| text visual ops | CanvasKit text/path primitives using HWP-compatible positions | no CanvasKit text measurement authority in `hwpCompat` |
| `GlyphRun` variants | exact font/face/instance replay only | selected/rejected diagnostics exact |
| `GlyphOutline` payloads | feature-gated strict replay | shared payload family validator and unsupported fixture |

`BlackWhite` and `Pattern8x8` are pixel contracts rather than approximate
color filters. Canvas2D and the shared Rust helper use the same rounded luma,
128 black/white threshold, ordered 8x8 Bayer matrix, source-image phase, and
alpha preservation. Native Skia and layered SVG preprocess supported raster
resources to PNG and replay the binary result with nearest-neighbor sampling.
Binary crop replay uses the strict decoded-pixel subset covering the authored
source rectangle (`floor(left/top)` through `ceil(right/bottom)`) so Bayer phase
and nearest sampling stay aligned across CanvasKit, native Skia, and SVG.
An encoded resource that cannot be decoded still follows the existing explicit
filter/fallback path; that fallback is not treated as binary-effect parity.

P2 does not require every unsupported branch to be fully replayed immediately.
It does require every branch to be visible in diagnostics, with a deterministic
fallback or rejection path.
Replay-plan direct status for image-bearing ops is based on resolved resource
bytes, not merely on a numeric resource handle. A `LayerImagePaint` or page
background image with a dangling `ImageResourceId` is reported as
`directRequired` with `missingImageData`, matching the CanvasKit runtime path
that can only decode from the exported resource arena. `directRequired` remains
a distinct replay-plan status and count, but it now makes document preflight
ineligible. Schema-v1 blocker JSON uses the existing `unsupported` code so the
public blocker vocabulary remains stable.
`textFallbackItems` is different: it inventories compatible direct CanvasKit
`TextRun` selection when a strict glyph variant is unavailable, so it does not
make document preflight ineligible. A variant group with neither a replayable
strict variant nor a default `TextRun` fallback reports `noSupportedVariant`
and adds an `unsupported` preflight blocker. This keeps ordinary compatibility
fallback eligible while fallback-free strict text still fails closed.

HWPX image-fill modes remain distinct in the parser and paint IR even when
their current replay geometry is identical. In particular, `TOTAL` is exported
as `total` rather than being collapsed into `fitToSize`; Canvas2D, CanvasKit,
SVG, and native Skia replay both values as a non-aspect-preserving stretch.
The HWPX header and shape parsers also preserve the image child's resource id,
brightness, contrast, and effect attributes so replay policy and runtime
receive the same operation. Fill-mode parity fixtures cover both values.

Page-background images preserve the legacy HWP `ImageFill` storage order in
the parser/render tree, then normalize it once at PageLayerTree lowering.
Layer `brightness` and `contrast` are display-space values, while `opacity`
records page compositing explicitly. The verified RealPic watermark preset
uses opacity `0.26`, legacy non-RealPic watermarks use `0.17`, and ordinary
RealPic tone adjustments remain opaque. Canvas2D, direct CanvasKit, SVG,
WebCanvas, and native Skia consume that same lowered contract; the browser
lifecycle fixture compares the Canvas2D and CanvasKit composited pixels.

Picture crop coordinates now retain the HWP/HWPX `imgDim` full-coordinate
reference as `originalSizeHu` through the model, render tree, paint IR, and
public browser payload. `imgDim` is a crop-coordinate range, not the picture's
`orgSz` placement size. Canvas2D, CanvasKit, SVG, WebCanvas, and native Skia use
the same conversion order: a valid `imgDim` reference first, the historical
crop right/bottom adaptive range second, and the fixed 75 HU-per-pixel
compatibility scale only when neither range is usable. HWPX serialization
roundtrips `imgDim` verbatim, newly inserted pictures initialize it from the
decoded natural pixel size, and native static-picture keys plus CanvasKit
capability details include the reference so crop changes cannot reuse stale
replay state.

#### P2 Execution Update: CanvasKit As A Canvas2D-Compatible Backend

The current task is not to add a second hidden renderer behind CanvasKit. It is
to make the existing CanvasKit backend behave like the Canvas2D backend for the
same `PageLayerTree` operations, while keeping the implementation native-ready
for future Skia output. Work should therefore reduce one operation-family
difference at a time.

The working order is:

1. Align replay diagnostics with runtime behavior. `src/renderer/canvaskit_policy.rs`
   and `rhwp-studio/src/view/canvaskit-renderer.ts` must classify the same
   operation families as direct, direct-required, selected strict variant, or
   fallback/reject. The browser contract test now pins this relationship for
   page backgrounds, images, equations, form objects, text-special ops, vector
   shapes, `GlyphRun`, and `GlyphOutline`.
   Encoded-image plan admission is intentionally two-stage. Rust validates only
   the format header, dimensions, and resource-size bounds; an admitted raster
   item remains `direct` but carries
   `runtimeCondition=canvasKitEncodedImageDecode`, while an admitted SVG image
   carries `runtimeCondition=browserSvgImageDecode`. Studio then records the
   actual codec result. Missing resources remain `missingImageData`, and bytes
   rejected by static admission report `encodedImageRejected`; the plan does
   not mislabel either case as a runtime decode failure.
   Replay items can require more than one runtime proof. `runtimeCondition`
   remains the first condition for compatibility with existing plan readers,
   while `runtimeConditions` carries the complete ordered set. Images with a
   non-`realPic` effect or nonzero brightness/contrast add
   `canvasKitImageEffectPreprocess` after decode. Pattern-filled rectangles,
   ellipses, and paths add `canvasKitPatternImageConstruction` only when a
   usable two-color gradient does not win the same gradient-before-pattern
   runtime precedence. These conditions describe successful direct replay
   prerequisites; they do not waive the existing hard failures for effect
   preprocessing fallback or pattern surface construction failure.
   The browser baseline joins these item declarations to page-level
   image-effect and pattern cache attempts. `observed`, `unobserved`, and
   `failed` remain diagnostic inventory (`unobserved` can result from a static
   picture cache hit), while a runtime attempt with no matching declaration is
   a `runtimeConditionUndeclared` hard-gate violation.
   A statically verified `GlyphRun` similarly carries
   `runtimeCondition=canvasKitTypefaceConstruction`: Rust proves the bounded
   font resource, digest, face, glyph IDs, and paint contract, while Studio
   proves that the active CanvasKit build can construct that exact typeface.
   Only an observed `fontFaceInstantiationFailed` rejection may resolve this
   condition into a compatibility `TextRun` fallback.
   A statically sanitized `SvgGlyph` carries
   `runtimeCondition=canvasKitSvgPathConstruction` because Rust can validate
   the bounded SVG/path grammar but cannot construct a path through the active
   CanvasKit build. Only an observed `pathDecodeFailed` rejection resolves that
   condition. Missing resources and other static contract failures remain
   ordinary plan/runtime mismatches rather than conditional fallbacks.
   Browser replay ordering is also one shared contract: Canvas2D and CanvasKit
   traverse `background`, `behindText`, `flow`, and `inFrontOfText` planes in
   the same order as native Skia and layered SVG. Source order remains stable
   inside a plane, while wrapped images cannot move above or below flow content
   merely because their source op was emitted earlier or later. Text variant
   selection diagnostics are collected only during the flow-plane traversal,
   so plane replay does not duplicate selection reports.
2. Close high-priority direct replay gaps before opening broader text or
   authority changes: page background image/gradient fill, image effects,
   equation replay parity, form object bounds/parity, raw SVG or placeholder
   previews, path gradient/pattern/fill edge cases, and line/arrow/connector
   edge cases. The CanvasKit equation layout fallback keeps natural font
   advances instead of scaling every token to its layout box. Equation text,
   numbers, functions, and symbols use the same single-line CanvasKit Paragraph
   shaping path as static SVG and form text, preserving the producer-authored
   baseline while allowing kerning, ligatures, and provider-backed fallback.
   Direct `drawText` remains only a construction/draw failure recovery. The
   renderer centers only the token kinds that Canvas2D centers, constructs
   `()[]{}` stretch delimiters as direct Skia paths, and preserves the authored
   equation stroke widths.
   Radicals, hats, and vector arrowheads retain connected path joins, while
   tildes use the same two quadratic segments as Canvas2D, including
   subpixel-width equation strokes.
   `getEquationReplayDiagnostics()` reports whether each equation used direct
   SVG or layout replay and distinguishes requested layout from missing SVG
   resources, unsupported static payloads, invalid bounds, and CanvasKit path
   decode failures. Static-picture entries retain those route diagnostics so a
   cache hit reports the same fallback inventory as the recording render.
   Canvas2D and CanvasKit also share one drawable-content gate for equation SVG:
   a parsed fragment is direct-replayable only when it contains a visible
   fill, stroke, or text paint. Paintless and fully transparent fragments use
   the equation layout fallback instead of suppressing it merely because an
   SVG path parsed successfully. Both browser backends also validate the
   supported SVG path command grammar before drawing, so incomplete path data
   routes to the same visible layout fallback instead of being accepted as an
   empty browser `Path2D`. This equation routing rule does not change the strict
   `SvgGlyph` contract, where an intentionally invisible glyph payload may
   still be a valid selected visual variant.
   Text inside a supported static SVG fragment is shaped as one paragraph
   through the registered CanvasKit font provider before its measured width and
   alphabetic baseline are used to apply SVG anchors; cluster-by-cluster drawing
   remains only a failure fallback so kerning, ligatures, and joining survive.
   Form-object captions and values use the same single-line Paragraph builder.
   Their Canvas2D-compatible font metrics still own vertical centering, the
   shaped line width owns push-button centering, and direct `drawText` remains
   only a construction/draw failure fallback. Combo-box buttons are painted
   after the shaped value so they retain Canvas2D's overflow-covering order.
   Logical fallback family names remain stable in the public replay contract,
   while CanvasKit registers bundled regular and bold files under distinct
   internal provider families. Direct text and Paragraph replay resolve the
   requested weight to that physical family before matching, so an available
   bold face cannot silently resolve to the first registered regular file.
   Non-ASCII superscript and subscript shaping keeps that provider path without
   replacing HWP placement: grapheme Paragraphs are prepared before drawing,
   positioned at their authored cluster offsets, and aligned by each
   Paragraph's alphabetic baseline. A construction failure falls back before
   any Paragraph is painted.
3. Continue root `TextRun` effect parity fixture by fixture: vertical and
   rotated text, ratio/spacing, shade/outline/shadow, underline/strike/emphasis
   dots, tab leaders, control marks, character overlap, field markers, and
   line-break-sensitive cases. These remain `hwpCompat` visual replay work, not
   shapedModern layout authority changes. Inline control coverage includes
   paragraph-end, line-break, space, and tab marks under their shared output
   option gates. Both browser backends use the checked-in `D2Coding` symbol font
   for these marks, so CanvasKit does not depend on browser-only system font
   fallback for the arrow and line-break glyphs. CanvasKit text outline Paints
   use the same round stroke join as Canvas2D for both root `TextRun` and
   selected `GlyphRun` replay. Character-overlap text derives its middle
   baseline from the selected glyph bounds, with the CanvasKit font ascent and
   descent as a fallback, instead of a font-size constant. This matches
   Canvas2D `textBaseline = "middle"` placement.
   Supplementary-plane root text keeps the authored family first, then uses the
   checked-in `Latin Modern Math` face before generic fallback. CanvasKit probes
   the authored face and the math face by glyph id, while Canvas2D uses the same
   ordered CSS family chain; this makes supported non-BMP mathematical letters
   deterministic without replacing glyphs supplied by the authored font.
   All six HWP emphasis-mark variants use shared
   circle, line, and quadratic geometry in both browser backends, avoiding
   browser-only symbol-font fallback for the less common marks. Tab leaders
   likewise share the complete HWP fill-type geometry: zero omits paint, 1
   through 7 cover solid and dash variants, and 8 through 11 preserve authored
   double/triple lines. Underline and strikethrough replay also preserves all
   shape values 0 through 12, including dash, round-dot, compound, wave, and
   double-wave geometry in both inline and externalized decoration paths. Shape
   shadow alpha is multiplied by the authored shape opacity before replay,
   matching the Canvas2D `globalAlpha` composition contract. Canvas2D uses an
   explicit shadow-only blur pass, like CanvasKit, so rectangle, ellipse, and
   path sources are composited exactly once after their fill/stroke shadows
   instead of being repainted by a native shadow pass.
   Shape fill selection also falls through in Canvas2D order: an unusable
   gradient tries the authored pattern before the solid fill color. Path
   connectors derive start and end arrow directions from the first and last
   usable line or cubic tangent, and a paired arrow/no-arrow fixture verifies
   endpoint ink in both
   Canvas2D and CanvasKit. Rounded rectangles clamp authored corner radii to
   half the smaller bound before either direct fill/stroke or shadow replay.
   SVG-style paths establish the same initial current point in both browser
   backends: an initial `lineTo` starts at its endpoint, an initial `curveTo`
   starts at its first control point, and an initial `arcTo` starts at its
   endpoint. None of these commands paints from an implicit origin. This
   mirrors Canvas2D/SVG path semantics and prevents CanvasKit `PathBuilder`
   from introducing an extra segment before the first real one.
4. Keep `GlyphRun` and `GlyphOutline` strict replay gated by exact resource
   proof. `ResourceArena` font blobs, glyph ids, sidecar selection diagnostics,
   bitmap/SVG/color glyph payloads, and fallback-free profiles must not be
   widened until the corresponding proof fixtures exist.
   Strict `GlyphRun` admission is shared by producer lowering, the v2 strict
   writer, Rust replay planning, native Skia, and the CanvasKit browser runtime.
   Runs fail closed before font resolution when they are empty, exceed 4,096
   glyphs/positions/advances/clusters, have mismatched glyph geometry counts,
   contain values outside the finite f32 range, use a non-positive or greater
   than 4,096 px font instance, or disagree with the shape key's direction or
   writing mode. These cases use the same deterministic diagnostics across
   backends: `emptyGlyphRun`, `glyphRunTooLarge`,
   `glyphPositionCountMismatch`, `glyphAdvanceCountMismatch`,
   `positionNotFinite`, `advanceNotFinite`, `placementNotFinite`,
   `fontInstanceInvalid`, and `glyphRunMetadataMismatch`. Synthetic style,
   proved bidi splits, and proved upright/sideways vertical runs remain eligible
   when their payload metadata agrees; the bounded contract does not close
   those previously verified paths.
   Paint-style eligibility is likewise identical in the Rust replay plan and
   browser runtime. The shared paint projection carries tab leaders explicitly
   so strict glyph variants cannot silently omit them; superscript and
   subscript remain ineligible for fill-only outlines until their transformed
   geometry is canonical.
   The proved single-face CanvasKit `GlyphRun` subset includes fill, finite
   offset shadow, the current binary outline pass, and emboss/engrave relief
   passes. Rust lowering, replay planning, the browser font registry, and
   CanvasKit direct replay use the same subset; underline, strike, emphasis,
   shade, non-default ratio, script, and non-finite effects remain deterministic
   `TextRun` fallback cases. Relief uses the same fixed white/gray/original
   three-pass order as Canvas2D `TextRun`, with opposite offsets for emboss and
   engrave. A missing or non-positive ratio follows the root `TextRun` contract
   and normalizes to `1`; a finite positive ratio outside the strict unit-ratio
   tolerance remains a fallback case. This widens optional compatibility
   variants only; fallback-free v2 strict writer emission keeps its existing
   fill-only gate.
5. Treat resource/cache identity as part of correctness. Image bytes, static
   SVG fragments, font blobs, output options, replay plane, and strict sidecar
   payloads must all participate in cache keys so stale pictures cannot hide
   renderer differences.
6. Defer any public default switch until representative Canvas2D-vs-CanvasKit
   corpus diffs, failure diagnostics, fallback/unsupported inventories, and
   performance/memory smoke results are stable enough to become hard gates.

The browser baseline now records the Rust replay plan, CanvasKit runtime text
variant selections/rejections, encoded-image recovery/failure diagnostics,
TextBlob replay diagnostics, v2 validation issues, pattern surface/direct-image
diagnostics, and surface diagnostics for every CanvasKit capture. Hidden-overlay items,
hidden-overlay violations,
invalid direct-only plan contracts, empty plans, direct-required image items,
runtime image/image-effect/TextBlob/pattern replay failures, and v2 validation
issues are hard failures. Failure to create an image-effect surface is not
itself a replay failure when exact integer source pixels can be read directly;
the recovered effect remains cacheable and must match the surface path in the
browser fixture. If exact readback is unavailable, an image-effect
preprocessing failure may draw the original image for the current compatibility
attempt, but it is reported as a replay failure and is never admitted to the
static picture cache. That fallback uses the original image's crop and
linear/mipmap sampling path; an unmaterialized effect request must not force
nearest-neighbor sampling or claim that a crop was already preprocessed. Runtime
reports are deduplicated by equivalence group plus `anchorOpId`, so a
leaf-local group reused at another anchored text slot cannot overwrite the
first report. Conflicting repeated selections fail. Rust-plan/runtime
alignment requires the selected variant ID, kind, anchor, expected part count,
and complete replayed part count to match; an ID-only match is not sufficient.
The sole exception is an explicitly declared plan
runtime condition whose exact failure is observed before Studio selects the
`TextRun` fallback. For example, `canvasKitEncodedImageDecode` is resolved only
by an `imageDecodeFailed` rejection of that selected strict variant; an
undeclared mismatch, an unknown failure, or a fallback-free mismatch remains a
hard failure. Resolved conditions remain visible in
`runtimeConditionResolutions`. Intentional TextRun fallback, unsupported items,
direct-image/direct-text recoveries, and their exact reasons remain an inventory
in the JSON and Markdown reports. Static CanvasKit pictures that encounter any
runtime replay failure are drawn for the current attempt but not cached, so a later
diagnostic reset cannot turn a cached omission into a false pass. A recovered
TextBlob construction failure is also kept out of the picture cache, ensuring
that direct-text recovery stays observable on each retry instead of disappearing
behind cached picture metadata. Cache admission compares diagnostics before and
after each static subtree, so a failure or recovery in one subtree does not
disable caching for unrelated siblings.

CanvasKit fallback text now consumes the same `FONT_LIST` face catalog as the
Canvas2D `FontFace` loader for the aliases it replays directly. This preserves
bold-only families such as `HY헤드라인M`, regular-only families such as
`HY신명조` and `Palatino Linotype`, and explicit 400/700 families without
registering a different style set in CanvasKit. Synthetic emboldening is used
only when that shared catalog has no 700 face for the resolved family. The
Batang, Malgun Gothic, and mixed Korean/English browser fixtures retain selected
raster diff zero in both CanvasKit modes. The larger repeated-header page keeps
its residual text-position/raster difference report-only rather than hiding it
through a looser font substitution.

The shared font matrix also maps the Dotum/Gulim family aliases (`돋움`,
`돋움체`, `굴림`, `새굴림`, and `Haansoft Dotum`) to the independent
`Noto Sans KR ExtraLight` family. Browser renderers use the checked-in WOFF2
face and native Skia uses the matching checked-in TTF; all three fallback
chains place that family before the regular Noto sans faces. The independent
face intentionally advertises weight class 400, so aliases register it as 400
rather than pretending it is a weight variant of `Noto Sans KR`. The expanded
Regular face remains registered for CanvasKit symbol and box-drawing coverage.
Catalog parity tests pin the alias mapping, and the CanvasKit font-coverage
smoke verifies both the Regular symbol subset and ExtraLight Korean/Latin
coverage. Old-Hangul jamo use the checked-in Source Han Serif K subset instead
of relying on incidental coverage in the ExtraLight face. Its browser
`@font-face` is limited to `U+1100-11FF`, `U+A960-A97F`, and `U+D7B0-D7FF`;
the preload supplies `ᄒᆞᆫ` as representative text so the range-limited face is
ready before direct Canvas2D replay. Canvas2D and CanvasKit share the same
grapheme predicate and explicitly select that family for any cluster containing
old-Hangul jamo, even when the authored face also exposes those codepoints.
CanvasKit registers the same bytes in its font provider. Its existing Paragraph
path therefore shapes the complete cluster once while retaining the
producer-authored HWP cluster position. The smoke pins all three source jamo and
the one-cluster Paragraph result, and browser lifecycle coverage verifies that
runtime selection actually reaches the dedicated face. Native strict replay
still requires a portable document font blob or a separately verified native
face; the bundled browser WOFF2 is not claimed as a native Skia font resource.
Document preflight continues to use the same PUA-expanded display projection:
bounded work counts include both preserved source text and a differing display
projection.

CanvasKit TextRun diagnostics expose how each authored primary family resolves
without changing that fallback behavior. Directly registered aliases are quiet;
substitution-table and weight-suffix mappings are reported as `mappedAlias`,
while an unregistered family that reaches a generic candidate or the final
default face is reported as `unregisteredFallback`. Each record includes the
paint op id, requested family, resolved family, and resolution source.
`unregisteredFontFallbacks` is therefore an observable parity risk rather than
a hidden successful replay. The diagnostic set is bounded, resets with document
resources, and is stored in static-picture metadata so a cache hit reports the
same substitutions as the recording pass. Renderer baseline JSON keeps the
per-capture records, while its backend/profile summaries inventory total
substitutions, unregistered fallbacks, and resolution-source counts. These
counts remain report-only until representative corpus data distinguishes
expected compatibility mappings from font-selection parity regressions.

Shared layout measurement now uses that same display projection for ordinary
run widths, source-sliced fragments, table/control offsets, and synthetic line
breaking. Source text is sliced before projection, so UTF-8/UTF-16 indexes,
control anchors, cursor boundaries, and `TextRun` source positions remain
unchanged even when one PUA scalar expands to several display scalars.
Unmodified text stays on a borrowed fast path. Char-overlap payloads retain
their one-control advance contract, while the nonpainting HWP TAC filler
`U+F081C` has explicit zero advance in embedded, WASM, source-position, and
unrounded line-breaking measurement paths. Canvas2D and CanvasKit therefore
consume the same authored bounds that correspond to the text they actually
paint.

Shared HWP text measurement applies authored percentage letter spacing to each
glyph's measured advance rather than to the font size. Full-width glyphs keep
their previous behavior, while spaces, punctuation, and other narrow glyphs no
longer receive full-em compression or expansion. The resulting positions are
authored once in the page tree and consumed unchanged by Canvas2D, CanvasKit,
SVG, and native Skia. Split-aligned lines with negative letter spacing also
reserve the last visible glyph's ink overhang before distributing remaining
width, preventing both browser backends from clipping the final glyph at the
cell edge. Layout tests pin the narrow-space progression and the complete
split-line occupied width.

The shared font matrix also models Hancom's verified HCR Batang substitution:
ASCII punctuation, digits, Latin letters, and `U+00B7` use Haansoft Batang
advances for the exact `함초롬바탕` and `HCR Batang` aliases, while space,
Hangul, HCR Dotum, and extension faces keep their own metrics. Parentheses use
the 0.3em fallback only for the measured Human Myeongjo/Hanyang Jung Gothic
families and KoPub; HCR Batang and unverified faces retain 0.5em behavior.
Because these decisions live in the embedded measurement gateway and its WASM
fallback, Canvas2D and CanvasKit receive identical authored run bounds.

CanvasKit vertical upright text also normalizes the vertical presentation forms
`U+FE19` and `U+FE31..U+FE44` to their horizontal base glyphs before font
selection. Font coverage probes, `TextBlob` cache
identity, negative-cache recovery, and direct drawing all use the same replay
text. The renderer measures the selected base glyph, centers it in the authored
vertical advance cell, and applies a local 90-degree CanvasKit rotation. Source
text, cluster positions, diagnostics, and the producer-owned bounding box stay
unchanged.

The `GlyphOutline` payload-family guard is shared by the v2 text validator,
CanvasKit policy, Rust SVG renderer, and native Skia renderer. A payload kind
must not carry sibling color/bitmap/SVG/stroke fields, and mixed payload
families now fall back or hard-reject before any backend tries to replay them.
Legacy `paths` are authoritative and range/command-validated only for the
monochrome fill and fill-stroke families. Rich color, bitmap, and SVG payloads
validate their dedicated payload contract and ignore stale legacy path storage,
keeping the Rust replay plan aligned with Studio runtime admission.
CanvasKit clip policy also mirrors Canvas2D's default right-overflow slop:
`body` and `tableCell` clips get the same 4px right pad when `clipPolicy` does
not explicitly provide `rightOverflowSlop`, while explicit clip policy values
remain authoritative. `textBox` render nodes lower to direct layer `ClipRect`
nodes with no implicit right pad, so Canvas2D, CanvasKit, SVG, and native Skia
can replay textbox overflow without a browser overlay.
The body clip itself is resolved after body layout. Flow subtrees may extend
the clip below the authored body area so an over-height paragraph, table, cell,
or text line is not lost by strict clip consumers. Floating drawing subtrees
retain the compatibility cap at 10px below the authored body bottom. The
resolved rectangle is part of `PageRenderTree` before layer lowering, so
Canvas2D, CanvasKit, SVG, PDF, and native Skia consume the same clip instead of
applying backend-local overflow exceptions.
Layer lowering preserves the authored body's horizontal clip for ordinary flow
and text, but routes an eligible control that crosses that clip through a
page-width horizontal clip at the control's original child position. Floating
drawing controls use stroke- and shadow-expanded visual bounds for this
decision; flow structures such as tables use their logical bounds so a border
centered exactly on the body edge retains legacy clipping. A routed control is
removed from the ordinary flow segment and lowered exactly once, so
semi-transparent paint, resource diagnostics, and replay-plane ordering cannot
be duplicated by a sibling overflow replay. Floating controls retain the
authored-body-plus-10px vertical cap while non-floating flow can use the
resolved post-layout height.
Canvas2D and CanvasKit gradient replay also share the same stop normalization
helper, including the Canvas2D behavior where missing explicit stops are
materialized as `0` and stop pairs are ordered by offset before CanvasKit sees
the Skia positions array. Image replay also shares the image-only effective
bbox helper for perpendicular rotations: Canvas2D, CanvasKit, Rust SVG, native
Skia, and legacy Rust canvas paths swap image bbox extents around the same
center before applying the authored 90/270 degree rotation, while non-image
shapes keep their authored bbox.
RawSvg fragments that are exactly one embedded `data:` image are lowered to the
same `Image` paint op and resource table path as ordinary pictures. This keeps
OLE/chart preview images on the shared Canvas2D/CanvasKit/native image replay
path instead of depending on an SVG or DOM image overlay.
Ordinary HWP/HWPX image resources may now also contain bounded SVG documents.
Rust and Studio share the same admission contract: UTF-8 XML with an `svg`
root, no doctype, a resolvable positive intrinsic size or `viewBox`, at most
4 MiB of source bytes, at most 8192 pixels on either raster axis, and at most
32 Mi pixels. The Studio resource cache decodes an admitted SVG asynchronously
through a browser image source and immediately converts it with
`MakeImageFromCanvasImageSource`; the decoded pixels are then painted only by
CanvasKit. This narrowly scoped decode bridge is not a Canvas2D compositing
overlay: rhwp never creates a canvas context or inserts a browser-canvas paint
layer. CanvasKit 0.41's `MakeImageFromCanvasImageSource` helper may internally
use a temporary browser canvas to normalize decoded pixels, but its result is
immediately a CanvasKit `Image` and never an overlay surface. A future native
backend uses its native image codec at the same adapter boundary. A pending
decode prevents static-picture caching until the callback requests a fresh
direct replay. Decode failures are negative-cached with the ordinary image
diagnostics.
CanvasKit accepts the decoded image only when its integer width and height
exactly match the bounded encoded header; mismatches delete the decoded object
and record `decodedDimensionsMismatch`, for both synchronous raster decode and
the browser-assisted SVG bridge. Replacing bytes in the same resource table
changes the content-specific key and clears the matching negative cache before
retry.
Native Skia parses the same admission header, rasterizes through `usvg`/`resvg`
at the replay destination and output scale, and keys the SVG cache by resource,
destination size, and scale. Raster resources retain their resource-only cache.
The native image shader maps raster pixels to the authored logical tile size,
so destination-sized SVG rasters do not change tile spacing or origin.
HWPX shape-local `<gradation><color .../>` stops must be materialized by the
section parser before this replay layer sees the shape fill; otherwise all
backends receive an empty gradient color list and can only fall back or paint a
backend default.

### P3. Native-Ready Strict Payloads

P3 starts only after the relevant P2 family is stable enough that strict payload
fixtures can isolate schema behavior from renderer gaps.

| Payload or feature | First implementation gate |
| --- | --- |
| `ColorLayers.ColrV1` | preserve implemented stage-1 through stage-5 graph guardrails; add later primitives only with concrete payload demand |
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

Purpose: preserve the implemented COLRv1 stage-1 through stage-5 graph subsets
and add future primitives only without changing text variant selection or
paint-order semantics.

Implementation shape:

- keep `ColorLayers` canonical as producer-normalized paint data, not a
  font-native COLR table reference;
- keep COLR/CPAL table references, source glyph ids, palette indices, font
  digest, and face identity as provenance/debug/cache data;
- require COLRv0 resolved-layer payloads to carry top-level source font
  provenance, a valid source span, a non-empty glyph span, at least one resolved
  layer, and no `paintGraph`; COLRv1 owns the graph envelope;
- keep the tree-only stage-1 graph containing `solidPath` and local `transform`
  nodes as the cross-backend compatibility baseline;
- treat `linearGradientPath` and `radialGradientPath` as the first stage-2
  graph leaves; their gradients carry producer-resolved color stops and
  remain inside the glyph payload's run-local coordinate space; non-finite,
  out-of-range, or unordered stop offsets are invalid;
- treat `sweepGradientPath` as the stage-3 graph leaf for full 360-degree
  run-local sweep gradients only; partial-angle sweeps remain invalid until a
  portable Canvas2D/SVG/native contract is fixed;
- treat `composite` with `sourceOver` as the first stage-4 graph node; it paints
  the backdrop child first and then the source child inside the glyph payload,
  validates both child refs, and does not introduce global blend modes,
  paint-order changes, or scope changes;
- treat `clip` as the first stage-5 graph node; its clip path is a run-local
  path inside the glyph payload, clips only its child subgraph, and does not
  create a page/layer `ClipRect` scope or a cross-scope variant;
- allow reusable DAG subgraphs after stage 5; shared child refs are valid, but
  cycles, unreachable nodes, graph sizes over the stage limit, and depth over
  the stage limit remain invalid;
- keep COLRv1 graph payloads exclusive from legacy `layers`; a payload that
  carries both the normalized graph and resolved layer list is invalid because
  it gives renderers two canonical paint descriptions;
- allow only run-local affine transforms inside the glyph payload;
- reject graph nodes that alter `PaintOp` order, clip scope, effect scope,
  cache scope, or cross-scope variant behavior;
- reject unreachable nodes, cycles, node counts over the stage limit, and depth
  over the stage limit.

The implementation baseline now covers stage 1 through the first stage-5
subset. Contract coverage pins the shared graph traversal helper so Canvas2D
and CanvasKit keep the same backdrop-before-source `sourceOver` ordering, the
same run-local `clip` child traversal, and the same no-duplicate traversal
implementation. Remaining COLRv1 work should preserve those fixed semantics
and only add concrete follow-up primitives, such as additional blend/composite
modes, extra clip primitives, or reusable-node memoization, when a real payload
or document requires them. Unsupported graph features should otherwise keep
producing deterministic fallback/reject diagnostics.

Later COLRv1 additions should be staged as independent v2 feature additions:

| Stage | New graph capability | Writer status |
| --- | --- | --- |
| 1 | solid color plus transform | implemented baseline; continue fixture hardening |
| 2 | linear and radial gradients | browser Canvas2D/CanvasKit, Rust SVG, and native Skia implemented for resolved gradient path leaves; malformed stop offsets now reject deterministically; Canvas2D-vs-CanvasKit parity now covers duplicate-stop linear hard edges and radial red-center/blue-rim coverage |
| 3 | sweep gradients | browser Canvas2D/CanvasKit and native Skia implemented for full 360-degree run-local `sweepGradientPath` leaves; malformed or partial-angle sweeps reject deterministically; Rust SVG continues to reject/select fallback because the SVG backend has no portable native conic-gradient primitive |
| 4 | source-over composite | implemented for `sourceOver` source/backdrop graph nodes in browser Canvas2D/CanvasKit, Rust SVG, native Skia, JSON/JS bridges, and native cache keys; non-`sourceOver` blend/composite modes remain blocked |
| 5 | clip and reusable graph nodes | implemented for run-local `clip` child nodes and reusable DAG child refs in browser Canvas2D/CanvasKit, Rust SVG, native Skia, JSON/JS bridges, and native cache keys; reusable node memoization remains an optimization, not a schema requirement |

### 2. BitmapGlyph Strict Replay Hardening

Purpose: harden the strict image-strike contract before enabling broader writer
emission.

Implementation shape:

- canonical payload contains one producer-selected image strike;
- available strikes, missing ideal strikes, and chosen-strike reasons are
  diagnostics/provenance only;
- strict replay must not let the backend select a different strike;
- strict replay requires explicit `alphaMode`, `scalingPolicy`, `filtering`,
  placement, `sourceRangeUtf8`, and a non-empty `glyphRange`;
- strict replay rejects `backendDefault` scaling or filtering;
- missing color space defaults to sRGB only when the diagnostic records
  `colorSpaceDefaulted`; an explicitly present empty color-space value is an
  invalid strict payload rather than the sRGB default.

Canvas2D/CanvasKit, Rust SVG, and native Skia now share the single-strike strict
payload subset. Static picture cache keys already include image and
`ArrayBuffer` resource payload fingerprints, including both plain
`ArrayBuffer` and typed-array views; the same cache contract is now covered for
strict `SvgGlyph` vector resources so stale static pictures cannot survive a
same-key vector payload change. CanvasKit lifecycle also rejects
`BitmapGlyph` payloads with missing required strict fields or backend strike
reselection, missing image resources, and ambiguous resource keys before replay.
The Rust renderer path also rejects mixed bitmap/color/SVG payload families
through the same `GlyphOutline` exclusivity guard before replay. Schema-v2
strict GlyphOutline JSON and JS exports now declare
`text.glyphOutline.bitmapGlyph` whenever the selected strict payload uses the
one-strike bitmap contract, so strict consumers can gate the writer widening at
the export metadata layer instead of inferring it from the payload body. A
checked-in JSON payload snippet now pins the canonical `BitmapGlyph` export
body used by that strict writer gate.
CanvasKit lifecycle coverage now also rejects non-finite payload transforms,
missing alpha mode, backend-default scaling/filtering, non-positive strike
ppem, diagnostic-only strikes, and explicitly empty color-space values before
replay. Missing color space remains the only sRGB-default path and must record
`colorSpaceDefaulted`.
Before writer emission is widened, add broader real-document resource corpus
coverage.

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
- `glyphRange` must be non-empty so strict vector glyph replay remains anchored
  to an actual source glyph span;
- `intrinsicSize` is optional and diagnostic/layout-aid only.

The current baseline replays static path-layer fragments without DOM parsing in
Canvas2D/CanvasKit, Rust SVG, and native Skia. CanvasKit lifecycle coverage now
mutates a same-key `VectorResourceId` payload inside a static subtree and
requires a distinct static picture cache entry and changed pixels. It also
rejects external/reference primitives such as `<image href>` and `<use href>`,
plus unsupported vector primitives such as `foreignObject`, `filter`, `mask`,
and `clipPath`, as `unsupportedSvgGlyph` in both DOMParser and no-DOMParser
paths. CanvasKit lifecycle also rejects strict `SvgGlyph` payloads with missing
`viewBox`, unsafe static-vector flags, or raw inline SVG replay fields before
replay, rejects non-finite transforms and placements, rejects non-positive
intrinsic sizes and non-finite `viewBox`/intrinsic geometry, rejects non-static
security modes, and rejects missing or ambiguous vector resources. Static
vector admission is path-only and atomic: every path must pass the shared path
grammar, and both transform-list and nested-transform composition must remain
finite; opening and closing element names must also balance before the strict
variant can suppress its `TextRun` fallback. CanvasKit prepares each admitted
path once per render, uses that same decoded path for variant selection and
drawing (including GPU-to-software retry), and releases all prepared paths at
the end of the render so a later decode failure cannot leave a suppressed
fallback or partially painted strict variant.
If static admission finds no replayable path or rejects any path command, the
variant keeps `unsupportedSvgGlyph` as its category and records
`pathDecodeFailed` as the deterministic detail before selecting the `TextRun`
fallback.

Shared text layout now keeps the measured HFT identities `한양신명조`,
`한양중고딕`, `한양견명조`, `한양견고딕`, and `휴먼명조` instead of
collapsing them onto HY faces with different ASCII widths. CanvasKit treats
these PageLayerTree names as already resolved, registers portable serif/sans
aliases for direct replay, and preserves the heavy-family weight hints. The
raw HWP substitution table remains available to APIs that still receive
unresolved document font names; it is not applied twice to resolved layer
output. Canvas2D may still use a locally installed original HFT face, while
CanvasKit's portable TextRun fallback uses the registered bundled face until
an exact font blob is available.
Schema-v2 strict
GlyphOutline JSON and JS exports now declare `text.glyphOutline.svgGlyph` when
the selected strict payload uses the static sanitized vector contract. A
checked-in JSON payload snippet now pins the canonical `SvgGlyph` export body
used by that strict writer gate. Before writer emission is widened, add broader
real-document resource corpus coverage. The same exclusivity guard prevents
sanitized SVG payloads from being replayed when bitmap, color, or stroke
sibling fields are present.

### 4. CanvasKit And Native Skia Variation/TTC Proof Fixtures

Purpose: keep exact-font replay conservative until backend-specific face and
instance construction is proven.

Current policy is split by backend:

- CanvasKit still rejects variation-required `GlyphRun` variants with
  `variationUnsupported`. Digest-verified TTC/OTC non-zero `faceIndex` variants
  are replayable after the adapter validates and extracts the requested face
  into a bounded standalone SFNT. Malformed or out-of-range collection faces
  report `faceIndexUnsupported`.
- Native Skia may select the strict `GlyphRun` variant only for checked-in
  exact-font proof cases: direct TTF replay, selected variation tuples,
  explicit default-axis replay, alternate valid axis-bound replay, synthetic
  TTC non-zero `faceIndex` replay, exact-byte out-of-range fallback, invalid
  exact embedded font bytes, and digest-mismatch rejection.
- Backend divergence remains expected for variation tuples while CanvasKit
  stays conservative and native Skia has proof coverage. That difference must
  be explained by `VariantSelectionReport`.

The proof fixtures required before enabling backend strict replay are:

| Capability | Positive proof | Negative proof |
| --- | --- | --- |
| variation font | same variable font blob, canonical axis tuple, expected glyph ids, expected advances/bounds, stable native-vs-CanvasKit fuzzy output | unsupported axis, out-of-range axis, same font with different axis tuple, default-axis omission policy |
| TTC/OTC face index | same collection blob, explicit non-zero `faceIndex`, expected face metadata, expected glyph id mapping | wrong-face, high-index, and ambiguous metadata diagnostics |

CanvasKit glyph id replay must also keep the adapter range guard for public
`u32` glyph ids because the browser binding currently uses a 16-bit glyph id
path.

Current CanvasKit unit and lifecycle coverage proves exact TTC face 1 selection,
strict `GlyphRun` selection, fallback suppression, and visible proof-glyph ink.
It also covers face 2 and malformed collection directories as deterministic
negatives. Explicit variation tuples are still rejected for supported-axis
instances, unsupported-axis tags, out-of-range values, alternate axis tuples,
and explicit default-axis tuples. Native Skia renderer coverage keeps those
negative cases and the checked-in exact construction positives listed above.
Broader real collection corpus remains coverage widening rather than an
enablement prerequisite.

The CanvasKit font-coverage smoke also pins the installed public direct-glyph
API contract. Both typeface data factories accept only the font bytes, and the
runtime `Typeface`, `Font`, and `FontMgr` prototypes expose no variation/axis
method. Paragraph text style accepts `fontVariations`, but that path reshapes
text and cannot replay the IR's supplied glyph ids and positions. If a future
CanvasKit upgrade adds an exact direct-font axis API, this capability guard must
fail first so the `variationUnsupported` gate is revisited deliberately.

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

CanvasKit policy and native Skia renderer tests now keep both
`MixedPerGlyph` orientation and explicit glyph-transform runs behind that writer
gate: they reject the strict `GlyphRun` with `variantUnsupported`, select the
`TextRun` fallback, and do not misreport the case as a font verification
failure.

## Implementation-Ready Backlog

This backlog turns the design choices above into code-sized batches. Each batch
must leave CanvasKit and future native Skia on the same replay contract. If a
batch discovers that it needs browser-only parsing, hidden Canvas2D drawing, or
backend-dependent semantics, stop the writer work and add a validator,
diagnostic, or resource contract instead.

### Batch 1. COLRv1 Stage-4/5 Follow-Up Guardrails

Goal: preserve the implemented COLRv1 stage-1 through stage-5 graph vocabulary
and add new graph primitives only when they can stay inside glyph-payload
composition without changing text variant selection, global paint order, or
scope semantics.

Expected code shape:

- schema/type vocabulary keeps `ColorLayers.ColrV1` stage-1 nodes as the
  cross-backend baseline and admits the implemented stage-2/3/4/5 graph nodes;
- stage-1 nodes are `solidPath` and local affine `transform`;
- stage-2 nodes are `linearGradientPath` and `radialGradientPath` leaves with
  finite coordinates, ordered stop offsets, and resolved RGBA colors;
- stage-3 nodes are `sweepGradientPath` leaves with finite center coordinates,
  ordered stop offsets, resolved RGBA colors, and a full 360-degree angle range;
- stage-4 nodes are `composite` with `sourceOver` only, painting backdrop then
  source inside the glyph payload;
- stage-5 nodes are run-local `clip` child nodes plus reusable acyclic DAG child
  refs inside the graph size/depth limits;
- each `solidPath` contains producer-resolved path commands, resolved RGBA,
  `fillRule`, layer/source glyph provenance, palette provenance, and source
  range metadata;
- graph validation rejects cycles, unreachable nodes, unknown nodes,
  malformed gradients, partial-angle sweeps, non-`sourceOver` composites,
  unsupported clip primitives, scope-changing transforms, excessive depth, and
  excessive node count;
- any new graph primitive first gets deterministic internal/native reference
  behavior before Canvas2D/CanvasKit/SVG exporter widening.

Likely touchpoints:

- Rust schema and text payload definitions;
- Studio text variant and glyph-outline payload status helpers;
- renderer contract tests for shared payload vocabulary and unsupported reasons;
- native/internal fixture code that can assert the normalized graph result.

Definition of done:

- COLRv1 stage-1 through stage-5 payloads continue to validate/replay only for
  the supported solid, transform, gradient, sweep, `sourceOver` composite,
  run-local clip, and acyclic reusable-DAG subsets;
- unsupported COLRv1 nodes, malformed gradients, partial-angle sweeps,
  non-`sourceOver` composites, and unsupported clip forms produce deterministic
  payload-contract diagnostics;
- no CanvasKit writer starts relying on font-native COLR table interpretation;
- no paint-order, clip, effect, cache, or cross-scope semantics change.

### Batch 2. BitmapGlyph Producer-Output Corpus Widening

Goal: preserve the closed strict image-strike contract while adding
producer-output fixtures that exercise the existing one-strike payload through
real lowering paths.

Expected code shape:

- `BitmapGlyph` strict payload validation continues to require one producer-selected image
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
  `colorSpaceDefaulted` diagnostic, while an explicitly empty color-space value
  rejects as malformed strict payload metadata.
- native Skia corpus coverage includes a checked-in PNG resource loaded through
  `ResourceArena`, so the strict path is exercised with stable repository bytes
  instead of only generated in-test pixels.
- checked-in strict JSON/JS/v2 validator coverage now pins both explicit sRGB
  color-space payloads and producer-defaulted payloads where `colorSpace` is
  omitted and the renderer diagnostics report `colorSpaceDefaulted=srgb`.
- `decode_font_bitmap_glyph_payload` now follows the actual font-native producer
  path: `ttf-parser` selects a requested `sbix`/bitmap-table strike, the producer
  accepts only a dimension-verified encoded PNG, interns those bytes in
  `ResourceArena`, and fills the existing producer-resolved strike contract.
  Raw mono/gray/BGRA table formats remain deterministic
  `unsupportedRasterFormat` cases until a canonical PNG/RGBA normalization path
  is justified by a real fixture.
- `RHWPBitmapSvgGlyphSmoke.ttf`, generated reproducibly by
  `scripts/generate_font_glyph_payload_fixture.py`, provides the checked-in PNG
  strike proof. Its unit fixture verifies strict payload construction and its
  native Skia fixture verifies strict variant selection and visible replay from
  the producer-created resource.

Likely touchpoints:

- producer-output fixture generation for image-backed text glyph payloads;
- resource corpus manifests and expected diagnostics for image-resource replay;
- renderer baseline coverage that proves Canvas2D/CanvasKit/native Skia keep
  placement and bbox behavior for the same one-strike payload.

Definition of done:

- compatibility export can still fall back to `TextRun` or `GlyphRun`;
- strictVisual without a valid image-strike payload hard rejects;
- checked-in resource corpus coverage continues to select the strict
  `BitmapGlyph` variant and keeps its ink inside payload placement and bbox;
- producer-output bitmap fixtures use the same deterministic alpha, scaling,
  filtering, placement, cache-key, and resource-lookup contract already covered
  by handcrafted strict payload fixtures.

### Batch 3. SvgGlyph Producer-Output Corpus Widening

Goal: preserve the sanitized static vector contract while adding
producer-output fixtures that exercise the existing `VectorResourceId` payload
through real lowering paths.

Expected code shape:

- canonical payload continues to reference `VectorResourceId` instead of inline
  raw SVG;
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
- native Skia corpus coverage includes a checked-in sanitized static SVG
  fragment loaded through `ResourceArena`, so resource lookup, static safety,
  viewBox normalization, and strict variant selection are covered together.
- checked-in strict JSON/v2 validator coverage now pins both the minimal
  payload without `intrinsicSize` and the optional-present payload with
  positive intrinsic geometry.
- `decode_font_svg_glyph_payload` now follows the actual OpenType `SVG ` producer
  path. It bounds and decompresses SVGZ input, requires UTF-8, validates the
  existing static-safe element/attribute subset, parses the complete XML
  document, resolves a positive root `viewBox`, and only then interns the
  vector resource. Unsafe or malformed font documents fail before resource
  insertion.
- The same generated font carries a compressed safe SVG glyph plus unsafe and
  malformed negative controls. Unit fixtures cover producer acceptance/reject
  behavior and native Skia replays the producer-created static resource through
  strict `SvgGlyph` selection.

Likely touchpoints:

- producer-output fixture generation for sanitized static vector glyph payloads;
- resource corpus manifests and expected diagnostics for vector-resource replay;
- renderer baseline coverage that proves Canvas2D/CanvasKit/native Skia keep
  viewBox normalization, placement, and static safety for the same
  `VectorResourceId` payload.

Definition of done:

- strict SVG/native Skia/CanvasKit eligibility all agree on the same sanitized
  static-vector contract;
- unsafe vector resources choose compatibility fallback or strict rejection;
- checked-in resource corpus coverage continues to select the strict `SvgGlyph`
  variant and replay visible static vector geometry;
- producer-output vector fixtures keep the same hard-false script, animation,
  external-resource, interactivity, cache-key, and no-raw-SVG contract already
  covered by handcrafted strict payload fixtures;
- no DOM parser, object URL, browser SVG element, or Canvas2D overlay is added.

### Batch 4. CanvasKit And Native Skia Variation/TTC Proof Fixtures

Goal: keep exact-font replay conservative while adding proof fixtures that can
eventually unlock backend support.

Expected code shape:

- CanvasKit continues to reject required variation instances with
  `variationUnsupported`; it accepts only TTC/OTC face indices that can be
  extracted into a bounded standalone SFNT and reports
  `faceIndexUnsupported` for invalid collection faces;
- native Skia selects strict replay only for checked-in exact-font proof cases
  and keeps deterministic fallback/reject diagnostics for unsupported or
  unproven variation and face-index cases;
- CanvasKit policy keeps a positive control for the default face/no-variation
  gate and distinct-face TTC positive/negative controls, so later variation
  enablement can be distinguished from a general GlyphRun regression;
- native Skia proof coverage includes checked-in font bytes instantiated and
  replayed as a normal TTF face, a synthetic same-face TTC, and
  `RHWPExactFaceSmoke.ttc`, a digest-pinned collection with two distinct faces.
  The second checked-in face carries a unique outline absent from face 0, so the
  positive cannot pass through a family or face-0 fallback; face index 2 is the
  paired out-of-range negative;
- CanvasKit policy and native Skia renderer coverage both include explicit
  variation negatives for unsupported axes, out-of-range values, and unproven
  tuples. Native Skia additionally covers selected supported axes, alternate
  valid axis-bound replay, explicit default-axis replay, synthetic non-zero
  face-index positives, and exact-byte out-of-range fallback;
- native synthetic wrong-face, high-index, and ambiguous-metadata fallback
  controls exist, and the checked-in distinct-face collection adds exact
  positive/negative construction proof. Third-party or document-derived
  collections remain optional corpus widening rather than an enablement gate;
- either backend may diverge only after its own proof fixtures pass. CanvasKit
  keeps `TextRun` fallback for variation cases but may select strict replay for
  normalized exact TTC faces; native Skia records fallback/reject reasons for
  unproven cases in `VariantSelectionReport`;
- proof fixtures record the exact blob, face, axis tuple, glyph ids, advances,
  bounds, and negative mismatch cases.

Definition of done:

- no CanvasKit strict replay enablement happens without positive and negative
  proof fixtures;
- native Skia can instantiate and replay the checked-in proof font as a direct
  TTF, a synthetic TTC face, and the unique second face of the digest-pinned
  checked-in TTC;
- public `u32` glyph ids keep the native exact-font and CanvasKit adapter range
  guards;
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

## Remaining Backlog

The current `skia` branch has closed the v2 envelope, the CanvasKit parity
baseline, COLRv1 stage 1 through stage 5 graph subsets, strict
`BitmapGlyph`/`SvgGlyph` resource corpus coverage, and font-construction proof
controls. Generic embedded SVG pictures are also a closed direct-replay image
format rather than a strict `SvgGlyph` special case. The issue #3460 HWPX
fixture covers a body SVG plus a repeated header SVG referenced by a
nonnumeric manifest id. Its focused screen-profile browser sweep captured
Canvas2D, CanvasKit compat, and CanvasKit default for both pages with four
comparisons passed, no direct-required or unsupported items, no runtime image
failures, and no hidden-overlay violations. The upstream/devel items audited
for CanvasKit parity are already
represented by current branch coverage: external-image injection uses the
synthetic Wasm/API and CanvasKit policy tests instead of importing sample-only
fixtures, textbox clip lowering is covered by `TextBox` clip support, TAC-only
line position preservation is already represented by the current positioning
fixes, and the strict glyph payload resource proof is represented by the
checked-in Bitmap/Svg fixture snippets plus policy tests. The remaining work
should keep that
compatibility model intact: add one v2 feature at a time, keep v1 compatibility
export available, and avoid layout or cross-scope authority changes unless
explicitly gated.

### Current Remaining Work Snapshot

Use this snapshot as the working order before opening any broader schema,
layout, or scope changes. The first group below is implementation-ready only
when the next commit supplies a concrete producer-output fixture, malformed
payload case, or renderer proof artifact. Do not invent new schema or writer
behavior just to make progress.

Fixture-ready lanes:

1. Strict `BitmapGlyph` and `SvgGlyph` corpus widening: the core strict payload
   contracts, SVG/native/CanvasKit negative gates, resource cache keys, and
   checked-in PNG/SVG corpus fixtures are in place. The existing CanvasKit
   representative HWP suite, plus image, equation, vector, form, and mixed HWP
   samples, is now part of the baseline manifest, so Canvas2D/CanvasKit browser
   sweeps, and native Skia sweeps when enabled, exercise real resource
   placement without changing the strict payload contract. The handcrafted
   strict payload fixture set now includes BitmapGlyph explicit-sRGB and
   sRGB-default JSON/JS/v2 validation, plus SvgGlyph minimal and
   intrinsic-size-present JSON/v2 validation. No additional handwritten
   contract fixture is needed unless it captures a newly discovered malformed
   payload or unsupported lowering case. Add only real producer-output strict
   payload fixtures that exercise lowering paths beyond those hand-authored
   contracts, one payload family at a time. `samples/hwpspec.hwp` now keeps the
   whole-page 16 by 13 BMP enlargement in the checked-in representative
   manifest. Its image geometry and flat-fill solid-ink metric match, while the
   remaining Canvas2D/CanvasKit sampler delta is bounded to nine channel levels.
   CanvasKit `FilterMode.Linear` remains the closest native-ready sampler;
   `FilterMode.Nearest`, mipmaps, and tested cubic resamplers all increased the
   isolated image diff. This remains rasterizer classification, not evidence of
   a missing paint operation, so do not add a hidden Canvas2D pre-pass.
2. Strict payload validation hardening: add only targeted malformed-payload or
   unsupported graph-node fixtures that exercise already-declared v2
   vocabulary and are backed by a concrete failing input or audit finding. Do
   not open new layout authority, paint order, or cross-scope behavior in these
   commits.

Proof-gated lanes:

1. CanvasKit exact-font replay: preserve bounded standalone-SFNT normalization
   for verified TTC/OTC collection faces and its distinct-face
   positive/negative fixtures. Keep explicit variation tuples on conservative
   fallback until a CanvasKit-specific public API path proves exact instance
   construction. Both paths preserve the `u32` glyph id range guard.
2. Native Skia variation corpus widening: native Skia now has checked-in
   variable-font replay proof with exact axis tuple construction,
   glyph/advance/bounds smoke, explicit default-axis replay, alternate valid
   axis-bound replay, and invalid-axis fallback. Add broader variable-font
   corpus before calling variation replay broadly covered.
3. Native Skia TTC/OTC corpus widening: native Skia now has a synthetic
   exact-face replay path for non-zero `faceIndex`, an exact-byte out-of-range
   `faceIndex` fallback proof, and synthetic wrong-face, high-index, and
   ambiguous-metadata fallback controls. Invalid embedded exact font bytes and
   declared digest mismatches fall back with `exactFaceUnavailable` instead of
   silently replaying through a system-family substitute. Add real collection
   fixtures and digest-pinned corpus cases before treating TTC/OTC replay as
   broad native coverage.
4. COLRv1 follow-up primitives: keep additional blend/composite modes, reusable
   graph memoization, and extra clip primitives rejected unless a concrete
   document requires them and the graph primitive remains inside the glyph
   payload.
5. Native/CanvasKit real collection and variable-font corpus: add real-world
   fixtures only after the synthetic/direct proof path is stable, so fixture
   licensing, digest pinning, and expected metadata do not obscure replay
   semantics.

Authority-gated lanes:

1. shapedModern width input and line breaking: keep `lineBreakRisk`
   report-only, keep `lineBreakWouldChange` absent, and keep `hwpCompat`
   authoritative until a representative corpus proves width deltas, fallback
   splits, cluster mapping, vertical metrics, table/cell behavior, and expected
   pagination differences.
2. Cross-scope variants: keep `text.crossScopeVariants` as vocabulary only
   until a concrete use case proves same-scope fallback is insufficient.
   `paintOrderSlotId + scopeRef` remains the intended representation.
3. Public `MixedPerGlyph` writer emission: keep homogeneous run splitting as
   the default until cluster/grapheme orientation, `GlyphTransformRun`,
   transformed `GlyphRun`/`GlyphOutline` replay, vertical fixtures, and backend
   fallback/reject policy are stable.

Non-goals for the remaining CanvasKit parity work:

- no hidden Canvas2D/SVG overlay fallback in the CanvasKit renderer;
- no WebGPU dependency for correctness; WebGPU surface creation remains behind
  an explicit `canvaskitSurface=webgpu`/`canvaskitSurfaceBackend=gpu` request,
  and software preference skips WebGL before replaying through CanvasKit's
  software surface;
- no shapedModern default-authority switch;
- no global paint-order, variant-selection, or cross-scope semantics change;
- no raw SVG-in-font direct replay or backend-selected bitmap strike in
  strictVisual payloads.

| Area | Current status | Remaining implementation | Gate before writer emission |
| --- | --- | --- | --- |
| COLRv1 stage 4 follow-up | `sourceOver` composite payloads validate and replay where supported | decide whether any additional blend/composite modes are worth enabling; otherwise keep unsupported modes as deterministic fallback/reject cases | any new mode must stay inside glyph-payload composition and must not change text variant selection, global paint order, or scope semantics |
| COLRv1 stage 5 follow-up | run-local `clip` graph nodes and reusable DAG child refs validate and replay where supported | decide whether reusable-node memoization or additional clip primitives are needed; otherwise keep remaining unsupported graph nodes as deterministic fallback/reject cases | any new graph primitive must stay inside the glyph payload and must not introduce page/layer clip scopes or cross-scope variants |
| BitmapGlyph corpus widening | strict contract, negative validation, native/CanvasKit replay, checked-in PNG corpus, strict export feature metadata, checked-in explicit-sRGB and sRGB-default JSON/JS/v2 payload snippets, SVG/native/CanvasKit deterministic-field rejection coverage, resource-cache key coverage, real HWP image samples in the browser baseline manifest, and a generated `sbix` PNG-strike producer fixture with native strict replay exist; the Rust CanvasKit plan performs bounded encoded-raster header admission and marks the selected item/part with `canvasKitEncodedImageDecode`, while Studio performs the actual CanvasKit decode before suppressing the `TextRun` fallback | add real-document bitmap-font corpus only when digest-pinned bytes are available; add non-PNG table formats only with a deterministic normalization fixture | one producer-selected strike, deterministic alpha/scaling/filtering, no strict `backendDefault`, resource bytes in cache keys |
| SvgGlyph corpus widening | sanitized static vector contract, negative validation, native/CanvasKit replay, checked-in SVG corpus, strict export feature metadata, checked-in minimal and intrinsic-size-present JSON/v2 payload snippets, SVG/native/CanvasKit static-contract rejection coverage, resource-cache key coverage, real HWP equation/vector/form samples in the browser baseline manifest, and a generated compressed OpenType SVG producer fixture with unsafe/malformed controls and native strict replay exist; Rust replay planning validates static path syntax and CanvasKit verifies that at least one sanitized path is accepted by its path parser before selecting the strict variant | add real-document static SVG-in-font corpus only when sanitized, digest-pinned source bytes are available | `VectorResourceId`, required `viewBox`, hard-false script/animation/external/interactivity flags, no raw SVG-in-font replay |
| Variation font strict replay | variation tuples are represented; native Skia has checked-in variable-font proof for exact axis construction, explicit default-axis replay, alternate valid axis-bound replay, glyph id, advance/bounds smoke, and invalid-axis fallback | widen native coverage with real variable-font corpus cases; keep CanvasKit fallback until its exact instance construction is proven | supported/out-of-range/unsupported/default-axis fixtures pass and backend constructs the exact instance |
| TTC/OTC strict replay | faceIndex is represented; native Skia and CanvasKit both replay the digest-pinned checked-in TTC with two distinct faces. Its unique face-1 glyph proves non-zero `faceIndex` selection, face index 2 falls back deterministically, CanvasKit rejects malformed bounded-normalization inputs, native synthetic wrong-face/high-index/ambiguous metadata controls pass, invalid exact embedded bytes and digest mismatches reject, and the `u32` glyph id guard remains | add more native/browser collections only as real-document corpus widening | checked-in distinct-face positive/negative controls pass and each renderer draws the requested face, not a family fallback |
| CanvasKit variation/TTC | exact TTC/OTC collection-face replay is enabled through bounded standalone-SFNT normalization; explicit variation tuples remain conservative fallback | add CanvasKit-specific exact variation instance proof before enabling variation replay; widen TTC corpus without weakening bounds | public API path proves the exact variation tuple, while TTC extraction keeps collection/table/output bounds and the `u32` glyph id range guard |
| shapedModern width input | v2 metadata and report-only `lineBreakRisk` exist | collect representative HWP corpus, calibrate width deltas, then add opt-in width input | hwpCompat remains default; shaping/measurement failure falls back to legacy HWP-compatible width |
| shapedModern line breaking | blocked behind width-input stage | add opt-in line-breaking profile and calibrated thresholds | line-level corpus diff, table/cell review, fallback font split, cluster mapping, and vertical metrics are stable |
| cross-scope variants | schema vocabulary and `text.crossScopeVariants` gate exist; writer emits same-scope variants | add first concrete use case only when same-scope fallback is insufficient | `paintOrderSlotId + scopeRef` semantics remain sufficient; unsupported compatibility profile can choose same-scope fallback; strict fallback-free rejects |
| MixedPerGlyph writer | vocabulary and gate exist; default writer uses homogeneous run split | add cluster/grapheme orientation mapping, `GlyphTransformRun`, GlyphRun/GlyphOutline transform replay, fixtures | shaped/vertical semantics are stable and unsupported backends have explicit fallback/reject policy |

The producer-side CanvasKit replay plan deliberately cannot claim an
`ExternalVerified` font is ready, because consumer registration and exact
typeface construction happen in the browser. It reports the conditional run as
`externalFontNotVerified` and keeps the `TextRun` fallback. Studio may promote
the same run only after the supplied bytes match the declared digest and
CanvasKit constructs the requested face; other non-portable font states remain
`fontNotPortable`.

Recommended implementation order from this point:

Replay diagnostics are now collected from the existing corpus. Browser captures
render the requested manifest page into a dedicated backend canvas instead of
implicitly taking the first visible page. The canvas stays DOM-attached while
Canvas2D image resources or CanvasKit browser-decoder recoveries settle,
pending animation frames drain, and one final scale-1 render fixes the
selected-page diagnostics. The baseline then encodes
intrinsic canvas pixels rather than a CSS/DPR-dependent element screenshot.
Checked-in page 5 of the repeated header-image document and page 4 of the
multi-section document exercise this path. The checked-in HWP and HWPX
diagonal-cell pair now also runs through Canvas2D and both CanvasKit modes, so
the concrete test-infrastructure gaps identified for this phase are closed.
The real `aift.hwp` corpus now pins the positioned-text path separately:
page 0 contains six explicit `textDecoration` ops, page 1 contains one
`charOverlap` op, and page 3 contains 24 `tabLeader` ops. Rust integration
tests assert those lowering counts and compare all three pages through native
Skia and layered SVG; the browser baseline compares the same pages through
Canvas2D and CanvasKit without a hidden overlay. CanvasKit collects text
variant diagnostics in a cache-independent pre-replay tree walk, so static
picture cache hits and the three replay planes cannot omit or duplicate the
runtime selection report compared with the Rust replay plan.
The browser baseline also applies per-sample `showParagraphMarks` and
`showControlCodes` settings before the selected-page capture. The real
`lseg-05-tab.hwp` paragraph-mark view now covers positioned spaces, tabs, and
line-end controls, while page 4 of `tac-img-02.hwpx` covers the document's real
table-of-contents tab leaders. This keeps view-option visuals and HWPX
positioned text in the same Canvas2D-versus-CanvasKit hard-safety workflow as
ordinary page replay.
The checked-in `pua-test.hwp` sample adds the corresponding real-document proof
for PUA and circled-character fallback. It complements the synthetic
`canvas-layer-text-script-parity` lifecycle fixture and keeps the original
glyph-loss regression from issue #2394 in the representative browser baseline.
The shared font matrix also pins U+33A1 `㎡`: the direct CanvasKit coverage test
verifies the D2Coding glyph, while the browser lifecycle fixture verifies
Canvas2D and CanvasKit selection plus visible replay. This closes the remaining
issue #2394 unit-symbol regression without relying on a host system font.
Final page-tree construction also clips vertically overlapping slices that
reference the same `BinData` image and share the same horizontal placement.
The correction runs once after master-page composition, proportionally shortens
the earlier slice's crop while retaining its `originalSizeHu` coordinate
reference, and is shared by SVG, Canvas2D, native Skia, and CanvasKit lowering.
Pairs in different replay planes are deliberately excluded because page-tree
traversal order does not define their actual paint order.
HWPX image-like `binaryItemIDRef` values are resolved through their exact
`content.hpf` manifest identity before section/header parsing. Nonnumeric IDs
and numeric IDs that do not match manifest position are normalized to the
internal document index, while duplicate IDs remain unresolved and embedded
font references retain their exact manifest identity.
Resource lookup keeps the source formats distinct after that normalization:
HWP5 references continue to prefer the one-based DocInfo record position and
fall back to sparse storage IDs, while HWPX references require an exact
normalized manifest ID. This prevents an omitted external or missing HWPX
manifest item from aliasing a later embedded image, image fill, chart, or font
resource in the compact `BinDataContent` vector.
Each later implementation commit should start from a concrete fixture, corpus
document, backend proof, or malformed payload that the current branch does not
already cover.

1. keep the expanded browser baseline manifest running over the checked-in
   CanvasKit representative suite plus paragraph, table, image, field, form,
   equation, footnote/endnote, hwpctl control, HWPX format, font mapping,
   header/footer, and mixed-document corpus.
   The manifest now includes paragraph indent, left/center/right/justified
   alignment, mixed Korean/English, punctuation and digit-only text samples,
   Hangul-only, Latin-only, space-count, and mixed Malgun/Times text samples,
   representative empty/no-ink text and font-mapping edge companions,
   nested table-in-textbox, vertical table positioning, inner-table,
   multi-table, IPC, border-style, modified/saved baseline table, and complex
   HWPERS table samples,
   Batang/BatangChe/Gulim/GulimChe/Malgun Gothic/Dotum/DotumChe font-mapping
   samples, image-start
   anchoring, TAC image placement, TAC control-case samples, a second
   header-image sample, group-box and draw-group vector samples, endnote
   routing, hwpctl control-reference
   documents, blog/HWPX form samples, HWPX text/table/image reference samples,
   Korean/English/math/math-no/science/social exam documents, H-pen drawing,
   legacy HWPML, loading-sensitive mixed documents, and multiple multi-section
   documents, plus public planning, RFP, technical, return-form,
   finance-statistics, PR/task regression, and multiple promotional real
   document variants so placement and text fallback regressions have more than
   one real-document shape;
2. widen strict `BitmapGlyph` beyond the generated producer proof only with
   real-document font fixtures that keep the existing one-strike resource
   contract;
3. widen strict `SvgGlyph` beyond the generated producer proof only with
   real-document font fixtures that keep the sanitized static vector contract;
4. widen native variation replay only with real variable-font corpus fixtures
   before considering CanvasKit variation replay;
5. widen native and CanvasKit TTC/OTC replay beyond the checked-in
   distinct-face collection only with real-document corpus cases, preserving
   CanvasKit's bounded standalone-SFNT normalization gate;
6. leave additional COLRv1 blend modes, reusable-node memoization, shapedModern
   layout mutation, cross-scope writer emission, and public `MixedPerGlyph`
   writer emission blocked until their explicit gates are satisfied.

### Remaining Work Register

Use this register to keep the remaining work split by implementation risk. A
track may move from "blocked" to "implementation-ready" only after its gate is
satisfied and documented in this file or in the fixture that proves it.

Implementation-ready tracks:

- `BitmapGlyph` corpus widening: the generated `sbix` PNG-strike fixture now
  proves font-table decoding, producer-selected resource interning, strict
  payload construction, native selection, and visible replay. Keep image-heavy
  HWP samples in the checked-in browser baseline manifest as placement and
  resource regression coverage, including image-in-table, image-start
  anchoring, and repeated header/footer image placement cases. Add
  producer-output strict payload fixtures beyond that proof only when they keep
  the existing one-strike payload contract: one producer-selected image strike,
  deterministic alpha/scaling/filtering, no `backendDefault`, resource bytes
  included in cache keys, and
  `colorSpaceDefaulted` diagnostics when sRGB is assumed. SVG strict replay now
  rejects backend-default
  filtering/scaling, missing alpha mode, missing or diagnostic-only strike
  selection, non-positive strike ppem, and empty color space directly in
  renderer selection tests; native Skia mirrors those deterministic-contract
  negatives in strict variant selection, and CanvasKit policy covers non-finite
  transforms, missing alpha mode, backend-default filtering/scaling,
  non-positive strike ppem, and non-producer-selected strikes.
- `SvgGlyph` corpus widening: the generated compressed OpenType SVG fixture now
  proves bounded decompression, static-safe/XML/viewBox validation, producer
  resource interning, unsafe/malformed rejection, native selection, and visible
  replay. Keep equation, vector, form, table-in-textbox, inner-table,
  header/footer, and mixed-document HWP samples in the checked-in browser
  baseline manifest as placement and resource regression coverage. Add further
  producer-output strict payload fixtures only when they keep the sanitized
  static `VectorResourceId` contract. Keep `viewBox` required, keep script,
  animation, external resources, and interactivity hard false, and keep raw
  SVG-in-font direct replay rejected. SVG strict replay now rejects missing or
  non-positive `viewBox`, non-positive intrinsic size, and unsafe payload flags
  directly in renderer selection tests; native Skia mirrors the same
  static-sanitized contract negatives, and CanvasKit policy covers script,
  animation, external-resource, interactivity, viewBox, transform, placement,
  intrinsic-size, and security-mode rejection.
- strict payload validation hardening: add or widen negative fixtures only for
  unsupported already-declared COLRv1 graph cases or newly found malformed
  strict payloads. The current Bitmap/Svg deterministic and static-sanitized
  negative gates are covered across SVG, native Skia, CanvasKit policy, JSON,
  JS-value export, and v2 validation for the accepted optional/defaulted
  payload fields.

Proof-gated tracks:

- native variation-font strict replay widening: native Skia exact variable-font
  replay is connected for a checked-in fixture, including exact axis tuple,
  explicit default-axis replay, alternate valid axis-bound replay, glyph id,
  advance/bounds smoke, and invalid-axis fallback. Add real variable-font corpus
  cases before calling native variation strict replay broadly covered.
- native TTC/OTC strict replay widening: native Skia exact non-zero `faceIndex`
  replay now covers both the synthetic same-face control and a digest-pinned
  checked-in collection whose face 1 has a unique outline absent from face 0.
  Its out-of-range index 2 control falls back with `faceIndexUnsupported`;
  synthetic wrong-face/high-index/ambiguous metadata, invalid direct bytes, and
  digest mismatch controls remain in place, and exact-font replay keeps the
  `u32` glyph id guard. Additional real-document collections are corpus
  widening, not a prerequisite for the current native exact-face proof.
- CanvasKit exact-font strict replay: exact TTC/OTC collection faces are enabled
  through bounded standalone-SFNT normalization, while malformed/out-of-range
  faces still report `faceIndexUnsupported`. Keep explicit variation tuples
  rejected with `variationUnsupported` until the public CanvasKit path proves
  exact instance construction. The `u32` glyph id range guard remains
  mandatory.
- COLRv1 follow-up primitives: keep unsupported blend/composite modes,
  additional clip primitives, and reusable-node memoization rejected unless a
  concrete document requires them and the new primitive remains entirely inside
  the glyph payload.

Authority-gated tracks:

- shapedModern width input: collect a representative HWP corpus, understand
  width-delta distribution, stabilize fallback font splits, cluster mapping,
  and vertical metrics, and review table/cell constrained documents before
  enabling opt-in width input. `hwpCompat` remains the default authority.
- shapedModern line breaking: wait until opt-in width input is stable, line
  risk thresholds are calibrated, expected pagination differences are
  documented, and line-level corpus diffs are reviewed.
- cross-scope variants: do not emit cross-scope writer output until a concrete
  use case proves same-scope fallback is insufficient. Until then,
  `paintOrderSlotId + scopeRef` is vocabulary only and compatibility renderers
  may choose same-scope fallback.
- public `MixedPerGlyph` writer: keep homogeneous run splitting as the default
  until cluster/grapheme orientation semantics, `GlyphTransformRun`, transformed
  GlyphRun/GlyphOutline replay, vertical fixtures, and backend fallback/reject
  policy are stable.

Do not mix authority-gated work into CanvasKit parity commits. The current
CanvasKit parity target is direct replay of Canvas2D-visible behavior without
hidden Canvas2D overlays, not a change to HWP-compatible layout authority,
global paint ordering, or text variant selection semantics.

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
(cd rhwp-studio && npm test)
(cd rhwp-studio && node e2e/renderer-contract.test.mjs)
(cd rhwp-studio && npm run build)
git diff --check
```

`npm test` is the fast Studio guard for browser-free CanvasKit parity contracts.
It covers render-backend option parsing, replay-plane ordering, no-overlay
source contracts, shared image-effect pixel preprocessing, and the source-level
strict `GlyphOutline` payload gates for COLRv0/COLRv1, BitmapGlyph, SvgGlyph,
and monochrome stroke payloads. The Studio CI job and the full renderer sweep
run this fast test step before launching browser renderer suites, so pure
contract regressions fail before expensive CanvasKit E2E setup.

When runtime behavior changes, also run the relevant lifecycle/parity fixture,
usually:

```bash
(cd rhwp-studio && node e2e/renderer-lifecycle.test.mjs)
```

The lifecycle suite always gates the checked-in single-face COLRv0 color-font
smoke: the exact digest and face must verify, the `GlyphRun` variant must be
selected, red and blue layer pixels must render, and the `TextRun` fallback must
remain suppressed. This fixed-fixture capability gate does not automatically
promote arbitrary color fonts to fallback-free strictVisual eligibility.

When a change touches strict payload semantics or native-ready Skia behavior,
also run the targeted native Skia replay suite:

```bash
cargo test --features native-skia native_skia
```

Larger native-vs-CanvasKit PNG matrices remain report-first until thresholds and
flake rates are understood.

The fast headless E2E suite keeps one-sample WebGPU-preferred and software
CanvasKit smoke runs for the `eq-01` fixture. The branch-level full E2E check
can also be run with:

```bash
(cd rhwp-studio && RHWP_RENDER_SAMPLE_SCOPE=full npm run e2e:ci)
```

That command exercises the checked-in browser corpus in both CanvasKit
`compat` and `default` modes plus the smoke and lifecycle suites. By default it
uses the three-iteration replay performance guard from
`canvaskit-render.test.mjs`; local one-iteration full sweeps are still useful as
report-first triage, but they do not exercise the same CI performance guard. It
is the strongest local software-surface parity check. The E2E runner reserves
120 minutes for `RHWP_RENDER_SAMPLE_SCOPE=full` and keeps the representative
suite at 30 minutes; `RHWP_E2E_CI_TIMEOUT_MS` remains the explicit override for
either scope. The full timeout covers both CanvasKit modes and the lifecycle
suite rather than terminating the development server midway through the second
half of the corpus. The per-case performance guard keeps its existing global
and sample-scoped budgets, but treats a first failure as an outlier candidate.
The runner restarts Chromium and independently remeasures the Canvas2D and
CanvasKit pair once; only the fresh measurement is used for the final assertion
and aggregate row. Both the rejected attempt and the accepted or failing retry
remain structured metrics. This requires a reproducible second failure without
weakening a budget after a long software-surface sweep. Set
`RHWP_CANVASKIT_PERFORMANCE_GUARD_RETRIES=0` to disable the retry when auditing
raw performance noise. Every CanvasKit corpus capture resets replay diagnostics,
renders page zero explicitly, and then reads the profile-aware Rust replay plan
and browser renderer diagnostics for that same page. The sweep rejects hidden
overlay, direct-required, unsupported, runtime image/image-effect/text/pattern,
text-v2 validation, undeclared runtime-condition, and text-variant alignment
failures before accepting pixel parity. This check still does not
prove a real WebGL or WebGPU surface when the local browser/CanvasKit build
falls back to software. The manual `Full Renderer Sweep`
workflow captures the representative multi-profile baseline, then captures
separate WebGPU-preferred and software CanvasKit baselines. The representative
baseline also passes `--include-pdf`, so the native output matrix records the
current SVG-derived PDF export artifact next to legacy SVG, layer SVG, and
native Skia PNG outputs. Those wider surface-axis outputs are artifacts for
diagnosis and threshold tuning, not default CI gates. The browser baseline
report also compares Canvas2D against
CanvasKit compat/default for each sampled profile with the same report-only
fuzzy PNG metrics used by the renderer sweep, so CanvasKit parity drift can be
triaged from the baseline artifact without adding a fast-path gate. The renderer
contract test pins the representative manifest sample ids, categories, and
sample-file existence so this checked-in corpus cannot be accidentally narrowed
while later payload-specific fixtures are added. Large baseline runs can use
`--shard-index` plus `--shard-count`; the driver and standalone browser capture
both assign normalized `id + file + page` identities with
`sha256-first64-be`, and the driver rejects any native/browser selected-ID
mismatch. The hash assignment is independent of manifest order, so executing
every index for one filter/count partitions the selected corpus without overlap
or omission. Manifest
samples may carry browser parity threshold overrides when an existing
renderer-sweep fixture already classifies the remaining delta as backend
rasterization, such as the `pic-crop-01` crop-sampling budget. Text-heavy
samples may set `maxDiffRatio: null` and rely on ink-mask / solid-ink raster
budgets instead, matching the native-text sweep behavior where geometry and
non-ink drift are the failure signals and glyph anti-aliasing deltas are
classified separately. A solid-ink pixel must be inside both ink masks and have
a locally flat 3 by 3 RGBA neighborhood in both captures. This still catches a
wrong flat fill color, while text or stroke anti-aliasing over a colored shape
does not become a false fill mismatch merely because the shape makes every
nearby pixel non-white. Samples with tiny Canvas2D replay baselines and stable
native dispatch/pixel parity may also carry scoped replay-performance budgets
instead of loosening the global CanvasKit guard. `hwpspec.hwp` is now a
checked-in example: a focused layer-tree probe found one 886 byte BMP decoded
as 16 by 13 pixels and drawn as a page-scale `image` op, and the current sweep
shows matching geometry with only a bounded low-amplitude sampler delta.
Linear filtering remains the closest CanvasKit path; nearest, mipmap, and
tested cubic variants perform worse. Treat this as a sampling-classified
corpus case, not a remaining direct-replay coverage gap. The Markdown report
mirrors target-backend/profile summaries, applied per-comparison thresholds, and
the worst browser comparisons so large sweeps do not require scanning every
screenshot row first.

The latest local closure pass completed `1419` Rust library tests with no
failures and one ignored test, rebuilt the web WASM package and Studio, and
passed the renderer contract guard. The full browser corpus covered 139 HWP
pages plus two feature cases. CanvasKit `compat` and `default` each reported 141
aligned replay-plan/runtime selections, no hidden overlay, no direct-required
or unsupported item, and no runtime image, image-effect, text, pattern, or
text-v2 validation failure. The completed `default` sweep averaged `29.079 ms`
for CanvasKit and `46.096 ms` for Canvas2D (`0.631` ratio) across all 141 rows;
capture averages were `114.629 ms` and `115.229 ms`, respectively. The latest
`compat` sweep reached the same functional closure and averaged `26.348 ms`
for CanvasKit versus `42.099 ms` for Canvas2D (`0.626` ratio), while two
non-reproducing software-surface performance outliers motivated the independent
retry policy above rather than wider corpus budgets.

Viewport layout recalculation also reapplies the current virtual-scroll
coordinates to every active page canvas. This positioning contract is shared
by Canvas2D and CanvasKit: a scrollbar, viewport-width, or grid-layout change
may move an existing surface without invalidating its pixels, so a page must
not retain coordinates from the previous layout pass. The browser lifecycle
suite deliberately corrupts an active canvas position and verifies that
recalculation restores its current page offset and centering/grid transform.

These results close the currently exercised Canvas2D direct-replay gap. The
remaining register is corpus, public-API proof, or layout-authority work:
real-document strict glyph payload widening, exact CanvasKit variation-instance
construction proof, TTC/OTC corpus widening beyond the checked-in exact-face
fixture, and explicitly gated shapedModern, cross-scope, or `MixedPerGlyph`
changes. None requires a hidden Canvas2D overlay or a new direct paint-operation
fallback.

Embedded PCX picture data is normalized by the layer-tree producer into a PNG
resource before resource interning. The decoder bounds dimensions and decoded
bytes, validates PCX RLE scanlines and indexed/true-color layouts, and leaves
malformed or unsupported input unmodified so normal replay admission still
fails closed. This is a producer boundary rather than a CanvasKit-only browser
recovery: Canvas2D, CanvasKit, SVG/native consumers, cache keys, crops, and image
effects all see the same portable bytes and decoded dimensions while the source
document retains its original BinData for round trip.
