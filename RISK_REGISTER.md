# Risk Register

이 문서는 `rhwp` 프로젝트의 렌더링, 레이어 IR, Skia, WASM export 관련 위험을 기록합니다.

갱신 기준: 2026-04-24 `skia` 브랜치 공개 코드 정적 리뷰 및 1차 parity 수정 반영

검증 범위:

- 이 평가는 정적 코드 리뷰를 기준으로 작성했습니다.
- 실제 HWP 샘플을 렌더링한 픽셀 골든 비교는 아직 수행하지 않았습니다.
- 각 항목의 `근거 수준`에서 코드상 확인된 문제와 골든 테스트로 확인해야 할 위험을 구분합니다.

근거 수준:

- `확인`: 코드 구조, API 경로, 필드 보존/누락, 백엔드 구현 차이로 확인된 항목
- `검증 필요`: 코드상 위험이 보이지만 실제 문서 fixture 또는 픽셀 골든으로 확인해야 하는 항목
- `제안`: 구조, API, 테스트, 운영 안정성을 높이기 위한 후속 투자 항목

상태 기준:

- `열림`: 현재 트리 기준으로 추적해야 하는 항목
- `완료`: 현재 트리 기준으로 더 이상 추적할 필요가 없는 항목
- `제안`: 설계 방향 또는 후속 투자 항목

우선 작업 순서:

1. 주요 출력 경로가 `PageLayerTree`를 타도록 `renderPageToCanvas`를 포함한 canonical layer IR 경로를 확정한다.
2. `CharOverlap`, `ControlMark`, `ParagraphMark`, `ArrowHead`, `ImageEffect`, `ClipPolicy`, `Transform`처럼 백엔드가 임의 해석하면 안 되는 의미를 PaintOp 또는 공통 lowering으로 명시한다.
3. Skia parity 1차 항목인 선 종류, line/path transform bbox, image effect/crop, arrowhead, text rotation/vertical/control marks를 먼저 수정한다.
4. 텍스트 shaping 전략을 확정한다. 단기적으로는 Skia Paragraph/TextBlob을 검토하고, 장기적으로는 shaped glyph run을 LayerTree에 넣는 방향을 검토한다.
5. stable resource key와 decoded resource cache를 도입하고, `CacheHint`를 실제 SkPicture/raster cache로 연결한다.
6. RenderTree -> LayerTree lowering 보존, backend 간 pixel parity, 실제 HWP sample regression의 세 축으로 골든 테스트를 확장한다.

최근 반영:

- `LayerRenderer`는 실패를 반환하고, raster PNG 경로는 background/max-dimension 옵션을 받을 수 있게 했다.
- JSON/JS layer export에 schema metadata와 image effect 필드를 추가했다.
- resource key hash를 Rust `DefaultHasher` 의존에서 stable FNV-1a 기반 key로 바꿨다.
- Skia line/path transform bbox, line type, connector arrow, image effect/crop, page background layering, raster dimension guard를 1차 수정했다.
- Canvas2D layer, CanvasKit, SVG, Skia의 image crop 축 계산을 맞추고 image effect 전달을 추가했다.
- layer cache key에 profile과 주요 출력 옵션을 포함했다.
- WASM `renderPageToCanvas`가 `PageLayerTree`를 만든 뒤 `WebCanvasRenderer`의 layer replay 경로로 렌더링하도록 전환했다.
- `PageLayerTree`에 출력 옵션을 실어 JSON/JS/TypeScript export로 전달하고, Skia text run이 paragraph/control mark 옵션을 반영하도록 했다.
- layer renderer API에 typed render error와 scale/DPI/color-space/output metadata를 추가했다.
- native Skia가 `CacheHint::StaticSubtree`를 실제 SkPicture cache로 사용하도록 연결했다.
- PaintOp logical bounds와 visual bounds를 분리하고 layer node bounds에 visual extent를 반영했다.
- Skia `LineRenderType` multi-stroke 동작을 native regression test로 고정했다.
- TextRun marker flags를 JSON/JS/TypeScript export에 보존하고 Canvas2D layer replay에서 outputOptions 기반 mark를 그리도록 했다.

---

## Rendering Architecture

### [ARCH-001] Canvas2D 실렌더 경로가 레이어 IR을 우회함

**심각도**: 높음  
**상태**: 완료
**근거 수준**: 확인  
**위치**: WASM `renderPageToCanvas`, `build_page_tree_cached()`, `WebCanvasRenderer.render_tree()`, layer export API

**설명**:

- 공개 WASM API에는 `PageLayerTree` export 경로가 있지만, 실제 Canvas2D 렌더링 경로는 `PageRenderTree`를 만들어 `WebCanvasRenderer.render_tree()`에 직접 전달하는 구조로 보입니다.
- 따라서 Canvas2D 실렌더 경로는 아직 `PageRenderTree -> PageLayerTree -> backend replay` 검증 경로를 타지 않습니다.

**영향**:

- Canvas2D, SVG layer, CanvasKit, native Skia가 서로 다른 의미 해석을 갖게 될 가능성이 큽니다.
- Layer IR이 기존 렌더 의미를 보존한다는 핵심 가정을 실사용 경로에서 검증하기 어렵습니다.

**권장 조치**:

- `CanvasLayerRenderer` 또는 JS-side layer replayer를 만들고, `renderPageToCanvas`도 기본적으로 `build_page_layer_tree_for_output()`을 타게 합니다.
- 기존 Canvas2D direct renderer는 fallback/debug 용도로 남깁니다.

**완료 메모**:

- WASM `renderPageToCanvas`가 `build_page_layer_tree_for_output(page_num, RenderProfile::Screen)`을 사용하도록 전환했습니다.
- `WebCanvasRenderer`에는 `PageLayerTree` replay entrypoint를 추가했고, 기존 `PageRenderTree` direct renderer는 debug/fallback 경로로 유지합니다.

---

### [ARCH-002] PaintOp가 아직 semantic render node에 가까움

**심각도**: 높음  
**상태**: 제안  
**근거 수준**: 제안  
**위치**: `paint_op`, `layer_tree`, Canvas2D/SVG/Skia replayer

**설명**:

- `TextRun`이 style, text, positions를 들고 있고 백엔드가 다시 glyph, control mark, rotation, vertical text 같은 의미를 해석해야 합니다.
- 이미지 효과, connector arrow, clip overflow, transform origin도 백엔드별 구현 detail로 남기 쉬운 구조입니다.

**영향**:

- 백엔드가 늘어날수록 feature drift가 누적됩니다.
- 한 백엔드에만 있는 특수 처리가 layer IR로 내려오지 않아 Skia/CanvasKit/SVG layer가 뒤처질 수 있습니다.

**권장 조치**:

- 편집용 semantic IR과 paint IR을 분리하거나, PaintOp를 `GlyphRun`, `Stroke`, `Fill`, `ImageDraw`, `Clip`, `Transform` 같은 더 낮은 단계로 낮춥니다.
- 최소한 `CharOverlap`, `ControlMark`, `ParagraphMark`, `RotatedText`, `VerticalText`, `ArrowHead`, `ImageEffect`, `ClipPolicy`, `Transform { matrix, origin }`을 명시적인 PaintOp 또는 공통 lowering 결과로 분리합니다.

---

### [ARCH-003] LayerRenderer와 LayerRasterRenderer API가 실패와 출력 옵션을 표현하지 못함

**심각도**: 중간  
**상태**: 완료
**근거 수준**: 확인  
**위치**: `LayerRenderer::render_page`, `LayerRasterRenderer::render_png`

**설명**:

- `LayerRenderer::render_page`가 `()`를 반환하면 backend 초기화 실패, resource decode 실패, unsupported op를 구조적으로 전달할 수 없습니다.
- `LayerRasterRenderer`가 `render_png(&PageLayerTree) -> Result<Vec<u8>, String>` 형태에 고정되어 scale, DPI, background, color space, JPEG/WebP, raw pixels, PDF/vector target을 표현하기 어렵습니다.

**영향**:

- unsupported feature가 조용히 누락될 위험이 있습니다.
- PNG 외 출력이나 고품질/인쇄 옵션을 추가할 때 API breaking change가 커질 수 있습니다.

**권장 조치**:

- `LayerRenderer::render_page`를 `Result<(), RenderError>`로 바꿉니다.
- `LayerRasterRenderer`에는 `RenderSurfaceOptions` 또는 `RasterRenderOptions`를 도입하고, scale/DPI/background/color space/output format을 명시합니다.

**완료 메모**:

- `LayerRenderer::render_page`는 `LayerRenderResult<()>`를 반환하고, backend 실패는 `LayerRenderError`로 전달합니다.
- `LayerRasterRenderer`에는 `render_raster` entrypoint와 `RasterRenderOutput`이 추가되어 bytes와 함께 format, surface size, DPI, color space metadata를 반환합니다.
- 기존 `render_png`/`render_png_with_options` 편의 API는 유지하되, 내부적으로 generic raster output 경로를 타도록 정리했습니다.
- `RasterRenderOptions`는 max dimension, scale, DPI, transparent clear, background color, color space, output format을 표현합니다.

---

### [ARCH-004] JSON/JS export schema와 canonical API 경계가 불명확함

**심각도**: 중간  
**상태**: 완료
**근거 수준**: 제안  
**위치**: JSON export, JS value export, `RenderBackend`, WASM public API

**설명**:

- JSON 문자열 export와 resource key hint가 있는 JS value export가 함께 존재하지만, 어느 API가 canonical인지 명확하지 않습니다.
- export schema에 `schemaVersion`, `unit`, `coordinateSystem`, `profile`, `resourceTableVersion` 같은 호환성 필드가 필요합니다.
- legacy RenderBackend와 신규 layered backend의 역할 경계도 API 이름만으로는 헷갈릴 수 있습니다.

**영향**:

- frontend가 구버전/신버전 IR을 안전하게 분기하기 어렵습니다.
- 대용량 이미지가 많은 문서에서 JSON 문자열 경로가 성능과 메모리 측면의 병목이 될 수 있습니다.

**권장 조치**:

- resource table + typed array 또는 resource key 기반 JS value export를 canonical API로 정하고 문서화합니다.
- JSON export는 debug/snapshot 용도인지, public wire format인지 역할을 명확히 합니다.
- schema version과 좌표계/단위/profile/resource table version을 필수 필드로 둡니다.

**완료 메모**:

- JSON/JS layer export root에 `schemaVersion`, `unit`, `coordinateSystem`을 추가했습니다.
- JSON/JS layer export root에 `profile`과 `resourceTableVersion`을 포함하고 Studio TypeScript 타입에도 반영했습니다.
- README/README_EN에 JS value export를 대용량 문서용 선호 frontend API로, JSON export를 debug/snapshot/schema regression 용도로 문서화했습니다.

---

### [ARCH-005] CacheHint와 layer cache key의 계약이 충분하지 않음

**심각도**: 중간  
**상태**: 완료
**근거 수준**: 확인  
**위치**: `CacheHint`, `DocumentCore` layer cache, `SkiaReplayContext`

**설명**:

- `CacheHint`에는 `StaticSubtree`, `PreferRaster`, `PreferVectorRecording` 같은 의도가 있지만, 실제 SkPicture cache 또는 raster cache로 이어지는 경로는 아직 명확하지 않습니다.
- `show_paragraph_marks`, `show_control_codes`, `show_transparent_borders`, `clip_enabled`, `debug_overlay` 같은 출력 옵션이 layer cache key/invalidation에 모두 반영되는지 확인이 필요합니다.

**영향**:

- 옵션을 바꿨는데 이전 layer tree가 재사용되는 문제가 생길 수 있습니다.
- cache hint가 이름과 달리 실제 cache를 만들지 않으면 성능 개선 효과를 예측하기 어렵습니다.

**권장 조치**:

- `CacheHint`가 당장 cache를 보장하지 않는다면 `RenderHint`로 이름을 낮추거나, 실제 cache 구현을 붙입니다.
- cache key에 subtree hash, resource hash, profile, scale, 출력 옵션 전체를 포함합니다.
- `StaticSubtree -> SkPicture`, `PreferRaster -> subtree bitmap`, `PreferVectorRecording -> print/PDF recording` 매핑을 명시합니다.

**완료 메모**:

- `DocumentCore` layer cache key에 page number, render profile, paragraph/control mark 표시, transparent border, clip, debug overlay 옵션을 포함했습니다.
- browser CanvasKit은 `staticSubtree`를 picture cache key로 사용하고 있습니다.
- native Skia도 `StaticSubtree` group을 `PictureRecorder`로 기록해 renderer-local SkPicture cache에 저장하고 재사용하도록 연결했습니다.
- Skia picture cache key에는 profile, output options, raster scale, node fingerprint, image/svg resource hash를 포함했습니다.

---

### [ARCH-006] PaintOp bounds가 visual extent를 충분히 표현하는지 확인해야 함

**심각도**: 중간  
**상태**: 완료
**근거 수준**: 검증 필요  
**위치**: `PaintOp::bounds()`, culling, cache invalidation, dirty rect 계산

**설명**:

- PaintOp bounds가 단순 logical bbox만 반환하면 stroke, shadow, underline, effect, arrowhead, thick stroke가 bounds 밖으로 잘릴 수 있습니다.

**영향**:

- culling, cache invalidation, dirty rect rendering에서 실제 보이는 픽셀이 누락될 수 있습니다.

**권장 조치**:

- `PaintBounds { logical, visual }`처럼 logical bounds와 visual bounds를 분리합니다.
- stroke width, shadow blur/offset, text decoration, image effect, arrowhead 확장을 visual bounds에 반영합니다.

**완료 메모**:

- `PaintBounds { logical, visual }`, `PaintOp::paint_bounds()`, `PaintOp::visual_bounds()`를 추가했습니다.
- 기존 `PaintOp::bounds()`는 Canvas2D replay 호환을 위해 logical bbox를 유지합니다.
- LayerBuilder는 leaf/group node bounds에 visual bounds를 사용해 stroke, double/triple line, arrowhead, shadow, text decoration extent가 cache/culling 후보 bbox에 포함되도록 했습니다.

---

### [ARCH-007] Skia antialias/sampling 정책이 profile과 cache hint에 과하게 섞여 있음

**심각도**: 중간  
**상태**: 제안  
**근거 수준**: 제안  
**위치**: Skia image sampling, clip antialias, render profile policy

**설명**:

- `FastPreview`/`PreferRaster`와 `Print`/`HighQuality`/`PreferVectorRecording` 기준으로 sampling 또는 clip antialias 정책을 나누는 것은 시작점으로는 괜찮지만, image/vector/text별 품질 옵션이 한 정책에 묶이기 쉽습니다.
- clip antialias를 끄는 preview 정책은 성능상 이해되지만 셀 경계와 도형 clipping에서 jaggy를 만들 수 있습니다.

**영향**:

- screenshot regression, print export, fast preview가 서로 다른 품질 목표를 갖는데도 같은 hint 조합에 묶여 결과 예측이 어려워질 수 있습니다.

**권장 조치**:

- image sampling, vector antialias, text rendering, clip antialias 옵션을 분리합니다.
- FastPreview와 screenshot regression 목표가 다르면 별도 profile 또는 explicit option으로 나눕니다.
- clip antialias fixture를 추가합니다.

---

## Backend Parity Bugs

### [BUG-001] Skia 텍스트 렌더링이 LayerTextRun 의미를 충분히 사용하지 않음

**심각도**: 높음  
**상태**: 완료
**근거 수준**: 확인  
**위치**: `LayerTextRunPaint`, Skia `render_text_run`, Canvas2D direct renderer

**설명**:

- `TextRunNode`/`LayerTextRunPaint`에는 rotation, `is_vertical`, `char_overlap`, `field_marker`, `is_para_end`, `is_line_break_end` 같은 정보가 있습니다.
- Canvas2D direct renderer는 글자겹침, 회전 텍스트, 문단부호/조판부호, 세로쓰기 문단부호를 처리하지만, Skia 텍스트 경로에서는 이 의미들이 충분히 반영되지 않는 것으로 보입니다.

**영향**:

- 같은 문서가 Canvas2D에서는 보이고 native Skia PNG에서는 빠지는 요소가 생길 수 있습니다.

**권장 조치**:

- 기본 텍스트, debug/control marks, 특수 텍스트를 분리합니다.
- `PaintOp::ControlMark`, `PaintOp::ParagraphMark`, `PaintOp::CharOverlap`, `PaintOp::RotatedText`, `PaintOp::VerticalText`를 검토합니다.

**진행 메모**:

- Skia text run이 `rotation`과 `is_vertical` 회전을 적용하도록 1차 수정했습니다.
- Skia text run이 `char_overlap`을 일반 glyph run 대신 겹침문자 도형/텍스트로 렌더링하도록 수정했습니다.
- `PageLayerTree`에 `LayerOutputOptions`를 추가하고 JSON/JS export로 전달해, Skia text run이 공백/탭/문단 끝/강제 줄바꿈 표시를 그릴 수 있게 했습니다.
- JSON/JS/TypeScript TextRun export에 `fieldMarker`, `shapeMarkerIndex`, `isParaEnd`, `isLineBreakEnd`를 추가했고, Canvas2D layer replay가 exported marker fields와 `outputOptions`로 공백/탭/문단 끝/강제 줄바꿈 표시를 그리도록 했습니다.
- control/paragraph mark의 별도 PaintOp 분리, CanvasKit marker replay, shaped text 전략은 아직 남아 있습니다.

---

### [BUG-002] 텍스트 shaping과 fallback 전략이 복합 문서에 부족할 수 있음

**심각도**: 높음  
**상태**: 완료  
**근거 수준**: 검증 필요  
**위치**: Skia text cluster/glyph path 경로, font fallback

**설명**:

- Skia 텍스트가 cluster split, `Font::text_to_glyphs_vec`, `font.get_pos`, glyph path 기반으로 그려지는 구조라면 HarfBuzz/Skia textlayout 수준의 shaping과 fallback을 충분히 보장하기 어렵습니다.
- ligature, kerning, emoji ZWJ, 복합 스크립트, OpenType feature, CJK fallback run split에서 차이가 날 수 있습니다.

**영향**:

- 한글 단순 조합은 보여도 혼합 언어/기호/emoji/복합 스크립트 문서에서 glyph 위치와 모양이 달라질 수 있습니다.

**권장 조치**:

- 장기적으로 layout 단계에서 shaped glyph run을 만들어 `PageLayerTree`에 넣습니다.
- 단기적으로 Skia backend에서 `skia_safe::textlayout::Paragraph` 또는 `TextBlob` 계열 사용을 검토합니다.
- Canvas2D/SVG/Skia metric parity fixture를 추가합니다.

---

### [BUG-003] LineRenderType이 Skia에서 단일 선으로 축소됨

**심각도**: 높음  
**상태**: 완료
**근거 수준**: 확인  
**위치**: `LineRenderType`, Skia line renderer

**설명**:

- `Single`, `Double`, `ThinThickDouble`, `ThickThinDouble`, `ThinThickThinTriple` 같은 선 종류가 있지만, Skia renderer에서는 단일 `draw_line`으로 처리되는 것으로 보입니다.

**영향**:

- 표 테두리와 도형 선이 legacy SVG/Canvas2D 또는 HWP 기준 결과와 다르게 렌더링됩니다.

**권장 조치**:

- backend마다 선 종류를 구현하지 말고, LayerBuilder 또는 공통 stroke utility에서 double/triple line을 여러 개의 `PaintOp::LineStroke`로 낮춥니다.

**완료 메모**:

- Skia line renderer가 double, thin-thick, thick-thin, triple line을 여러 stroke로 그리도록 수정했습니다.
- `ThinThickThinTriple`이 `Single`과 다른 separated stroke 결과를 내는지 native Skia PNG regression test를 추가했습니다.
- 공통 lowering으로 더 낮추는 구조 개선은 [ARCH-002]의 장기 과제로 남깁니다.

---

### [BUG-004] Line/Path transform pivot이 원점 기준으로 어긋날 수 있음

**심각도**: 높음  
**상태**: 완료  
**근거 수준**: 검증 필요  
**위치**: Skia `with_shape_transform`, `PaintOp::Line`, `PaintOp::Path`

**설명**:

- Skia `with_shape_transform`이 bbox가 없으면 `(0,0,0,0)` bbox를 사용하고, Line/Path 렌더링은 bbox 없이 transform을 넘기는 것으로 보입니다.
- Rectangle/Ellipse/Image는 bbox를 넘기지만 Line/Path는 다르게 처리됩니다.

**영향**:

- 회전/flip 중심이 도형 bbox 중심이 아니라 원점 쪽으로 잡혀 HWP 도형 위치가 틀어질 수 있습니다.

**권장 조치**:

- `PaintOp::Line`과 `PaintOp::Path`에 transform 기준 bbox를 명시합니다.
- 더 일반적으로 `Transform { matrix, origin }`을 공통 필드로 둡니다.
- rotation/flip/order golden fixture를 추가합니다.

**완료 메모**:

- Skia line/path 렌더링이 transform 적용 시 PaintOp bbox를 넘기도록 수정했습니다.
- `Transform { matrix, origin }` 구조화와 golden fixture는 후속 개선으로 남깁니다.

---

### [BUG-005] Path connector arrow가 Skia에서 누락될 수 있음

**심각도**: 높음  
**상태**: 완료  
**근거 수준**: 확인  
**위치**: Canvas2D Path renderer, Skia Path renderer

**설명**:

- Canvas2D renderer는 `line_style`과 `connector_endpoints`가 있으면 시작/끝 화살표를 계산해 그립니다.
- Skia path 렌더링에서는 path fill/stroke 외 arrow head 처리가 보이지 않습니다.

**영향**:

- connector/arrow 도형이 Skia PNG에서 불완전하게 보일 수 있습니다.

**권장 조치**:

- arrowhead를 backend별 구현 detail로 두지 말고 `PaintOp::ArrowHead`로 분리합니다.
- 또는 line/path stroke expansion 단계에서 공통 geometry로 낮춥니다.

**완료 메모**:

- Skia path renderer가 connector start/end arrowhead를 그리도록 수정했습니다.
- SVG layer path도 connector marker를 내보내도록 맞췄습니다.
- 명시적 `PaintOp::ArrowHead` 분리는 [ARCH-002]의 장기 과제로 남깁니다.

---

### [BUG-006] ImageEffect가 IR에는 있지만 Skia/export에서 무시됨

**심각도**: 높음  
**상태**: 완료  
**근거 수준**: 확인  
**위치**: `ImageNode.effect`, `LayerImagePaint.effect`, Skia `draw_image_bytes`, JSON export

**설명**:

- `ImageNode`와 `LayerImagePaint`에는 `ImageEffect`가 보존되지만, Skia `draw_image_bytes` 호출과 함수 signature에는 effect 인자가 없는 것으로 보입니다.
- JSON export에서도 image effect 필드가 누락된 것으로 보입니다.

**영향**:

- grayscale, blackwhite, pattern effect 같은 문서 이미지 효과가 backend/export 경로에서 사라질 수 있습니다.
- IR 보존 테스트가 없다면 누락이 장기간 숨어 있을 수 있습니다.

**권장 조치**:

- Skia color filter/color matrix/shader, Canvas2D ImageData filter, 또는 LayerBuilder 단계의 preprocessed image resource 중 하나로 effect 처리 방식을 정합니다.
- JSON/JS export schema에 effect를 명시적으로 포함합니다.
- image effect schema regression test를 추가합니다.

**완료 메모**:

- JSON/JS export에 `effect` 필드를 추가하고 schema regression test를 보강했습니다.
- Skia, Canvas2D layer, CanvasKit image draw에서 grayscale/blackwhite/pattern effect를 적용합니다.
- `pattern8x8`은 현재 기존 SVG 경로와 맞춘 grayscale fallback이며, 실제 HWP 패턴 효과 정밀도는 별도 fixture가 필요합니다.

---

### [BUG-007] 이미지 crop 계산과 fill mode 적용 범위가 의심스러움

**심각도**: 높음  
**상태**: 완료
**근거 수준**: 검증 필요  
**위치**: Skia `draw_image_bytes`, `ImageFillMode`, image crop

**설명**:

- crop 처리에서 `scale_x = right / image_width`를 계산한 뒤 `src_y`, `src_h`도 같은 scale로 나누는 구조라면 세로 crop이 틀어질 수 있습니다.
- crop이 `FitToSize | None`에서만 적용되고 tile/align 계열 모드에는 적용되지 않는 것으로 보입니다.

**영향**:

- 좌우 crop, 상하 crop, 비율이 다른 이미지, crop + tile/center/rotation 조합에서 픽셀 결과가 달라질 수 있습니다.

**권장 조치**:

- HWP crop 좌표계가 원본 이미지 기준인지, 잘린 후 사각형 기준인지, HWPUNIT 기반 가상 좌표인지 문서화합니다.
- crop only-x, crop only-y, crop both, crop + center, crop + tile, crop + rotation/flip fixture를 추가합니다.

**진행 메모**:

- Skia, SVG, Canvas2D direct, Canvas2D layer, CanvasKit crop 계산에서 x/y scale을 분리했습니다.
- Skia image replay는 crop source rect를 공통 계산해 `fitToSize`/`none`, align, tile 계열 fill mode에 모두 적용합니다.
- Canvas2D layer와 CanvasKit replay도 동일하게 crop source rect를 align/tile draw call에 적용합니다.
- native Skia regression으로 crop + center fill mode가 잘린 source rect만 그리는지 확인했습니다.
- native Skia regression으로 crop + tile fill mode도 잘린 source rect만 반복하는지 확인했습니다.
- 실제 HWP sample 기반 crop/effect/fill mode fixture 확장은 [TEST-006]에서 추적합니다.

---

### [BUG-008] 페이지 배경 레이어링이 Canvas2D와 Skia에서 다름

**심각도**: 높음  
**상태**: 완료  
**근거 수준**: 확인  
**위치**: `PageBackgroundNode`, Canvas2D direct renderer, Skia page background renderer

**설명**:

- `PageBackgroundNode` 주석과 Skia 구현은 이미지가 있으면 image만 그리고, 없을 때 fill/gradient를 그리는 image priority 방식으로 보입니다.
- Canvas2D direct renderer는 배경색 -> gradient -> image 순으로 모두 그리는 방식으로 보입니다.

**영향**:

- 투명 배경 이미지 또는 gradient + image 조합에서 backend 간 결과가 달라집니다.

**권장 조치**:

- HWP 의미가 image priority인지, fill/gradient 위 image overlay인지 확정합니다.
- `PaintOp::PageBackground { layers: Vec<BackgroundLayer> }`처럼 배경 레이어를 명시적으로 표현합니다.

**완료 메모**:

- Skia page background를 Canvas/SVG와 같은 fill/gradient 후 image overlay 순서로 맞췄습니다.
- 더 명시적인 `BackgroundLayer` 모델은 구조 개선 과제로 남깁니다.

---

### [BUG-009] Clip/overflow 정책이 backend마다 다름

**심각도**: 높음  
**상태**: 완료
**근거 수준**: 확인  
**위치**: Canvas2D Body/TableCell clip, Skia `ClipRect`

**설명**:

- Canvas2D direct renderer는 Body/TableCell clip에 우측 여유를 주고, Body clip 뒤 overflow control을 재렌더링하는 것으로 보입니다.
- Skia layer renderer는 정확한 rect로 clip합니다.

**영향**:

- 셀 끝 glyph, 여백 밖 도형, 편집 모드 overflow 표시에서 backend 결과가 달라질 수 있습니다.

**권장 조치**:

- `ClipRect`에 `right_overflow_slop`, `allow_horizontal_overflow_controls`, `clip_kind` 같은 의미를 넣습니다.
- overflow 재렌더링을 별도 PaintOp로 낮춥니다.

**진행 메모**:

- `ClipRect`에 `clipPolicy.rightOverflowSlop`과 `allowHorizontalOverflowControls`를 추가하고 JSON/JS/TypeScript export로 전달합니다.
- Body/TableCell clip은 기본 `rightOverflowSlop = 4.0`을 갖고, native Skia/SVG layer/WASM Canvas2D/CanvasKit replay가 같은 policy를 사용합니다.
- Body 좌우 overflow control은 y-only/full-page-width clip을 갖는 sibling layer replay로 낮춰 legacy Canvas2D의 재렌더링 경로와 맞췄습니다.
- 전용 `PaintOp::OverflowControl`로 분리하는 구조 개선은 장기 과제로 남깁니다.

---

### [BUG-010] FormObject 렌더링이 placeholder 성격에 가까움

**심각도**: 중간  
**상태**: 완료
**근거 수준**: 확인  
**위치**: `FormObjectNode`, Skia form object renderer

**설명**:

- FormObject에는 caption, text, fore_color, back_color, value, enabled 등이 있지만, Skia 렌더링은 form type별 버튼/체크박스/라디오/콤보/에디트를 hardcoded style로 그리는 부분이 많아 보입니다.

**영향**:

- 문서 인쇄 결과를 목표로 할 때 disabled/readonly/background/border/font 상태가 실제 HWP와 다를 수 있습니다.

**권장 조치**:

- FormObject 목표를 브라우저 기본 UI 유사 표시인지, HWP 문서 인쇄 결과인지 먼저 정합니다.
- 인쇄 결과가 목표라면 style lowering을 공통화하고 상태/색/테두리/font를 IR에 명시합니다.

**진행 메모**:

- Skia form object renderer가 `back_color`, `fore_color`, `enabled` 상태를 일부 반영하도록 수정했습니다.
- Canvas2D layer, CanvasKit native replay, CanvasKit overlay replay도 exported `backColor`, `foreColor`, `enabled` 상태를 form control fill/text/border/mark 색에 반영합니다.
- 출력 목표와 전체 style lowering은 장기 구조 개선으로 남깁니다.

---

### [BUG-011] Resource key가 Rust DefaultHasher에 의존함

**심각도**: 중간  
**상태**: 완료  
**근거 수준**: 확인  
**위치**: `ResourceArena`, `resource_hash`, image/svg interning

**설명**:

- resource interning key가 Rust `DefaultHasher`를 사용하면 hash 알고리즘 안정성을 장기적으로 보장할 수 없습니다.

**영향**:

- WASM frontend가 resource key를 캐시 키로 오래 보관하거나 서버/클라이언트/버전 간 공유하면 key 안정성이 깨질 수 있습니다.

**권장 조치**:

- resource key를 stable digest로 바꿉니다.
- 보안이 필요 없으면 `xxh3_64`, 장기 호환성이 중요하면 `sha256` 또는 `blake3`를 검토합니다.
- key format은 `img:<algo>:<digest>`처럼 버전화합니다.

**완료 메모**:

- resource hash를 Rust `DefaultHasher`에서 stable FNV-1a 64-bit 구현으로 바꿨습니다.
- JS resource key format은 `r1:{len}:{hash}` 형태로 버전화했습니다.

---

### [BUG-012] Native Skia PNG surface dimension guard가 약함

**심각도**: 중간  
**상태**: 완료  
**근거 수준**: 확인  
**위치**: Skia PNG `raster_dimension`, Canvas2D max dimension guard

**설명**:

- Skia PNG 경로의 `raster_dimension(length)`이 `length.round().max(1.0) as i32` 형태라면 NaN, Inf, 음수, 매우 큰 page size에 대한 명시적 guard가 부족합니다.
- Canvas2D 경로에는 16384px max guard가 있지만 native Skia path에는 같은 정책이 보이지 않습니다.

**영향**:

- 비정상 문서 또는 scale/DPI 옵션 추가 시 crash, OOM, undefined rendering behavior가 생길 수 있습니다.

**권장 조치**:

- `fn raster_dimension(length, max_dim) -> Result<i32, RenderError>` 형태로 바꿉니다.
- non-finite, negative, too-large를 명시적으로 error 처리합니다.
- Canvas2D와 Skia가 공유하는 dimension validation utility를 둡니다.

**완료 메모**:

- Skia PNG `raster_dimension`이 non-finite, non-positive, max dimension 초과를 `Result` error로 반환하도록 수정했습니다.
- 기본 max dimension은 Canvas2D와 같은 16384px 정책을 따릅니다.

---

### [BUG-013] Skia PNG clear/background 정책이 불명확함

**심각도**: 중간  
**상태**: 완료  
**근거 수준**: 확인  
**위치**: Skia `render_png`, page background renderer

**설명**:

- Skia PNG surface가 투명색으로 clear됩니다.
- 문서 page background가 항상 흰색으로 들어온다면 문제가 작지만, background node 누락 또는 transparent export와 white screenshot/export를 구분해야 하는 경우 결과가 달라집니다.

**영향**:

- viewer screenshot과 compositing용 transparent export 요구가 충돌할 수 있습니다.

**권장 조치**:

- `RenderSurfaceOptions { transparent: bool, background_color: Option<Color> }`를 둡니다.
- viewer/print PNG는 기본 흰 배경, compositing export는 transparent를 명시합니다.

**완료 메모**:

- Skia PNG 경로에 `RasterRenderOptions { transparent, background_color }`를 추가했습니다.
- 기존 `render_png`는 backward-compatible 기본 옵션을 사용합니다.

---

### [BUG-014] Font fallback이 host 환경에 의존함

**심각도**: 중간  
**상태**: 완료  
**근거 수준**: 확인  
**위치**: Skia `make_font`, `FontMgr::default()`, document font resolver

**설명**:

- fallback 후보는 있지만 `FontMgr::default()`의 system font 상태에 따라 결과가 달라집니다.
- 문서 내 embedded font 또는 document-specific fallback font path를 Skia renderer가 충분히 반영하기 어렵습니다.

**영향**:

- CI, 개발자 로컬, 배포 환경마다 screenshot regression 결과가 달라질 수 있습니다.

**권장 조치**:

- test/runtime font set을 고정합니다.
- CI에 Noto CJK/Nanum/HCR 계열 등 기준 font를 설치하거나, document font resolver를 주입 가능하게 만듭니다.

---

### [BUG-015] Line dash scale과 shape opacity semantics가 불명확함

**심각도**: 중간  
**상태**: 완료
**근거 수준**: 검증 필요  
**위치**: Skia dash/stroke/fill paint

**설명**:

- dash interval이 stroke width, zoom, DPI, render profile과 무관한 고정값처럼 보입니다.
- fill opacity와 stroke opacity가 하나의 style opacity로만 처리되는 구조라면 HWP의 alpha semantics와 다를 수 있습니다.

**영향**:

- dash/dot/dash-dot 선과 fill/stroke 투명도가 HWP 또는 legacy renderer와 다르게 보일 수 있습니다.

**권장 조치**:

- HWP dash 단위와 stroke width/DPI/profile 관계를 확인합니다.
- fill alpha와 stroke alpha가 독립이라면 IR에 분리합니다.

**진행 메모**:

- Skia dash intervals가 effective stroke width를 기준으로 스케일되도록 수정했습니다.
- `ShapeStyle`은 현재 fill/stroke가 공유하는 단일 `opacity`만 갖고 있어, 독립 alpha 처리는 모델/IR 필드 확장이 필요합니다.

---

### [BUG-016] 텍스트 장식, 공백, symbol/equation fallback 세부 동작이 취약함

**심각도**: 중간  
**상태**: 완료
**근거 수준**: 검증 필요  
**위치**: Skia underline/strike/emphasis, cluster skip, symbol SVG fragment, equation SVG fallback

**설명**:

- underline/strike/emphasis dot 위치가 vertical text, superscript/subscript, ratio, font metrics, CJK baseline을 모두 반영하는지 fixture가 필요합니다.
- 공백, 탭, figure space cluster를 건너뛰는 로직은 탭 리더, 조판부호 표시, 배경색, 밑줄 있는 공백과 충돌할 수 있습니다.
- 일부 symbol을 SVG fragment로 렌더링하면 parse/render 비용이 크고, equation SVG 실패 시 fallback 품질에 크게 의존합니다.

**영향**:

- 문서상 보이는 조판 세부 요소가 backend마다 빠지거나 위치가 달라질 수 있습니다.

**권장 조치**:

- 텍스트 장식/공백/control mark를 backend-local hidden rule이 아니라 명시적인 PaintOp 또는 shaped run metadata로 표현합니다.
- symbol/equation SVG fragment는 parse/render cache를 붙이고 fallback 품질 fixture를 둡니다.

**진행 메모**:

- Skia text replay가 tab cluster를 glyph로는 건너뛰더라도 `tab_leaders`를 별도 stroke로 렌더링하도록 수정했습니다.
- native Skia text feature fixture가 underline/strike/emphasis, vertical text, superscript/subscript 조합을 렌더링합니다.
- equation SVG resource 우선 사용 fixture와 repeated SVG resource/fragment cache regression으로 equation fallback/cache 위험을 고정했습니다.
- symbol fragment도 Skia replay context의 SVG fragment cache를 통해 반복 rasterize를 피하도록 회귀 테스트로 확인했습니다.

---

### [BUG-017] Image fill tile 계열의 dimension guard가 부족할 수 있음

**심각도**: 중간  
**상태**: 완료
**근거 수준**: 검증 필요  
**위치**: Skia `ImageFillMode` tile loop

**설명**:

- tile loop가 source image dimension을 `max(1.0)`로 보정하더라도 destination width/height가 non-finite이거나 매우 크면 문제가 될 수 있습니다.

**영향**:

- 비정상 문서 또는 극단 scale에서 긴 루프, OOM, 렌더 지연이 발생할 수 있습니다.

**권장 조치**:

- render entry에서 destination rect와 page surface dimension을 먼저 검증합니다.
- tile 반복 횟수에 상한을 둡니다.

**완료 메모**:

- Skia image draw에서 non-finite/invalid destination rect를 거르고 tile 반복 횟수 상한을 추가했습니다.
- invalid destination rect regression test를 추가했습니다.

---

## Performance And Resource Risks

### [PERF-001] 이미지/SVG/WMF/equation decode가 draw마다 반복됨

**심각도**: 높음  
**상태**: 완료
**근거 수준**: 확인  
**위치**: Skia `draw_image_bytes`, `decode_image`, `draw_svg_fragment`, WMF conversion

**설명**:

- image bytes decode, WMF -> SVG -> resvg render -> PNG encode -> Skia decode, SVG fragment parse/render가 draw마다 반복될 수 있습니다.
- 반복 이미지, 반복 수식, WMF가 많은 문서에서 비용이 커질 가능성이 큽니다.

**영향**:

- 긴 문서나 표/수식/이미지 반복 문서에서 렌더 시간이 크게 증가할 수 있습니다.

**권장 조치**:

- `SkiaReplayContext`에 `HashMap<ResourceId, skia_safe::Image>` cache를 둡니다.
- SVG fragment도 `svg_resource_id + target_size + color/profile` 기준으로 cache합니다.
- resource/performance regression test로 decode 횟수와 렌더 시간을 추적합니다.

**완료 메모**:

- Skia replay context에 이미지 리소스별 decoded `skia_safe::Image` cache를 추가했습니다.
- WMF 리소스도 동일한 이미지 리소스 cache를 통하므로 WMF -> SVG -> PNG -> Skia decode 변환을 같은 replay 안에서 반복하지 않습니다.
- 수식 SVG는 `svg_resource_id + target_size`, 텍스트 심볼 SVG fragment는 fragment 문자열 + target size 기준으로 raster cache를 적용했습니다.
- cache 동작은 native Skia unit test로 고정했고, 반복 문서 벤치마크와 렌더 시간 회귀 기준은 [TEST-009]에서 계속 추적합니다.

---

### [PERF-002] 일반 텍스트까지 glyph path로 그리면 성능과 hinting이 나빠질 수 있음

**심각도**: 중간  
**상태**: 완료
**근거 수준**: 검증 필요  
**위치**: Skia text glyph path renderer

**설명**:

- glyph path 렌더링은 outline/shadow/emboss 같은 효과에는 유용하지만, 일반 본문 텍스트까지 path로 그리면 TextBlob/Paragraph보다 느리고 subpixel/hinting 품질이 나빠질 수 있습니다.

**영향**:

- 긴 문서에서 텍스트 렌더링 성능이 떨어지고 작은 글자의 품질이 낮아질 수 있습니다.

**권장 조치**:

- 일반 텍스트는 TextBlob/Paragraph 경로를 사용하고, outline/shadow/emboss 등 path가 필요한 경우에만 glyph path를 사용합니다.

**완료 메모**:

- 효과가 없는 일반 Skia TextRun replay는 glyph path 생성 대신 `canvas.draw_str`로 그리도록 전환했습니다.
- outline/emboss/engrave/shadow처럼 기존 path 기반 효과가 필요한 경로는 유지했습니다.
- plain TextRun native Skia smoke test를 추가해 일반 텍스트가 계속 PNG에 렌더링되는지 확인했습니다.

---

## Test And CI Coverage

### [TEST-001] LayerBuilder totality test가 필요함

**심각도**: 높음  
**상태**: 완료
**근거 수준**: 제안  
**위치**: LayerBuilder, RenderNodeType lowering

**설명**:

- 모든 `RenderNodeType`이 의미 있는 PaintOp를 만들거나, 의도적으로 unsupported marker를 생성하는지 확인해야 합니다.
- 단순히 children group으로 통과하는 구조 노드와 실제로 그려야 하는데 누락된 노드를 구분해야 합니다.

**권장 조치**:

- RenderNodeType별 lowering totality test를 추가합니다.
- unsupported node는 explicit marker와 diagnostic을 남기게 합니다.

**완료 메모**:

- 모든 `RenderNodeType` variant가 structural group/clip 또는 명시적 paint op로 낮아지는지 확인하는 totality test를 추가했습니다.
- test-side expectation match에는 wildcard를 두지 않아 새 `RenderNodeType`이 추가되면 lowering 정책을 갱신해야 컴파일됩니다.
- 누락되어 있던 `Placeholder`는 `Rectangle + TextRun` paint op로 낮추고, `RawSvg`는 bbox-local SVG-backed replay op로 보존하도록 했습니다.

---

### [TEST-002] legacy SVG와 layer SVG 비교 fixture가 부족함

**심각도**: 높음  
**상태**: 완료
**근거 수준**: 확인  
**위치**: `SvgLayerRenderer`, legacy SVG comparison tests

**설명**:

- 현재 단순 text/rect 비교는 좋은 시작이지만 feature parity를 보장하기에는 부족합니다.

**권장 조치**:

- text style, image, crop, table clip, line types, gradient, pattern, arrows, form object, equation, page background fixture를 추가합니다.

**완료 메모**:

- legacy SVG와 layer SVG를 raster diff로 비교하는 fixture matrix를 추가했습니다.
- fixture matrix는 text style, spacing, equation, image crop, form object, drawing group 샘플을 포함합니다.
- table clip 샘플은 Body/TableCell right-overflow slop 차이를 작은 픽셀 허용치로 명시해 계속 회귀 감시합니다.
- 전체 `cargo test --lib -- --quiet` 기준으로 layer SVG parity 테스트가 통과하는 상태로 복구했습니다.

---

### [TEST-003] Skia golden test ladder가 필요함

**심각도**: 높음  
**상태**: 완료
**근거 수준**: 제안  
**위치**: native Skia PNG tests, screenshot regression

**설명**:

- Skia renderer의 basic rect PNG, surface size rounding, sampling policy 수준 테스트만으로는 feature parity를 보장하기 어렵습니다.

**권장 조치**:

- 1단계: `PageLayerTree` fixture -> PNG snapshot.
- 2단계: SVG layer rasterize 결과와 Skia PNG의 pixel/SSIM 비교.
- 3단계: 실제 HWP sample 기반 end-to-end screenshot regression.

**완료 메모**:

- synthetic `PageLayerTree` fixture를 Skia PNG로 렌더하고 layer SVG raster와 비교하는 테스트가 있습니다.
- Skia PNG와 layer SVG raster 비교는 exact, channel-tolerant, neighborhood-tolerant, ink-mask diff를 함께 계산합니다.
- 실제 HWP sample 기반 end-to-end screenshot regression은 basic text/table/equation/image/drawing/corpus 테스트로 구성되어 있습니다.
- focused native-Skia synthetic ladder와 basic/table HWP sample 테스트를 재검증했습니다.

---

### [TEST-004] 텍스트 fixture를 최우선으로 확장해야 함

**심각도**: 높음  
**상태**: 완료
**근거 수준**: 제안  
**위치**: text rendering regression tests

**설명**:

- 텍스트는 문서 렌더링의 핵심이며 backend drift가 가장 쉽게 사용자에게 보입니다.

**권장 조치**:

- 한글/영문/CJK 혼합, 숫자/기호 fallback, 회전 글자, 세로쓰기, 글자겹침, 위첨자/아래첨자, 장평/자간 fixture를 추가합니다.
- 음영/그림자/양각/음각/외곽선, 밑줄/취소선/강조점, 탭/공백 조판부호, 누름틀 field marker, 문단 끝/강제 줄바꿈 표시도 포함합니다.

**완료 메모**:

- native Skia 합성 텍스트 fixture를 추가해 한글/영문/CJK 혼합, 숫자, 회전 텍스트, 세로 텍스트, 글자겹침, 위첨자/아래첨자, 밑줄/취소선/강조점 조합을 한 번에 렌더링합니다.
- 기존 Skia text tests의 char overlap, output control marks, tab leaders, plain text 경로와 함께 텍스트 회귀 범위를 넓혔습니다.
- shaping/metric parity의 장기 전략은 [BUG-002]와 실제 sample 기반 Skia screenshot corpus에서 계속 다룹니다.

---

### [TEST-005] 도형/선 fixture를 세분화해야 함

**심각도**: 높음  
**상태**: 완료
**근거 수준**: 제안  
**위치**: shape, line, path regression tests

**설명**:

- 선 종류, dash, arrowhead, path transform은 Skia parity 위험이 큰 영역입니다.

**권장 조치**:

- double/triple line, dash/dot/dash-dot, arrowhead start/end, rounded rectangle, ellipse, Bezier path, arc, connector path fixture를 추가합니다.
- rotation, horizontal/vertical flip, group transform fixture도 추가합니다.

**완료 메모**:

- native Skia 합성 shape fixture를 추가해 triple/double line, dash-dot, arrowhead start/end, rounded rectangle, ellipse, Bezier path, arc path, connector arrow를 한 번에 렌더링합니다.
- rectangle/ellipse rotation 및 horizontal/vertical flip transform도 fixture에 포함했습니다.
- 기존 synthetic SVG-vs-Skia shape fixture와 multi-line stroke regression에 더해 선/도형 회귀 범위를 넓혔습니다.

---

### [TEST-006] 이미지 crop/effect/fill mode fixture가 필요함

**심각도**: 높음  
**상태**: 완료
**근거 수준**: 제안  
**위치**: image rendering regression tests

**설명**:

- crop/effect/fill mode는 IR 보존과 backend parity가 모두 필요한 영역입니다.

**권장 조치**:

- PNG/JPEG/GIF/BMP/WMF/TIFF fixture를 준비합니다.
- fit/stretch/center/tile, crop only-x/crop only-y/crop both, grayscale/blackwhite/pattern effect, transparent image over page background, image rotation/flip 조합을 포함합니다.

**완료 메모**:

- native Skia-vs-layer-SVG 합성 image fixture를 확장해 crop only-x, crop only-y, crop both, fit/center/tile fill mode, grayscale/blackwhite/pattern effect, 투명 이미지 over page background, image rotation/flip 조합을 고정했습니다.
- 확장 fixture가 드러낸 Skia `BlackWhite` effect threshold 오류를 수정했습니다.
- SVG image replay도 positioned/tiled fill mode에서 crop viewBox를 적용하도록 맞춰 Skia와 layer SVG의 crop source rect 의미를 일치시켰습니다.
- PNG/JPEG/GIF/BMP/WMF/TIFF 실제 샘플 확장은 별도 corpus 확장 작업으로 남깁니다.

---

### [TEST-007] clip/overflow fixture가 필요함

**심각도**: 높음  
**상태**: 완료
**근거 수준**: 제안  
**위치**: Body/TableCell clip, overflow control regression tests

**설명**:

- Body/TableCell clip의 우측 여유, Skia exact clip, overflow controls 재렌더링 차이를 잡는 테스트가 필요합니다.

**권장 조치**:

- 셀 끝 glyph, 여백 밖 도형, 편집 모드 overflow control fixture를 만듭니다.

**완료 메모**:

- native Skia-vs-layer-SVG 합성 clip/overflow fixture를 추가했습니다.
- fixture는 Body right-overflow slop, Body y-only/full-page-width overflow control replay, TableCell right-overflow slop을 한 장면에서 렌더링합니다.
- 기존 LayerBuilder 단위 테스트와 Skia clip policy 단위 테스트도 함께 확인했습니다.

---

### [TEST-008] pattern/gradient mapping golden 검증이 필요함

**심각도**: 중간  
**상태**: 완료
**근거 수준**: 검증 필요  
**위치**: Skia `make_gradient_shader`, pattern fill renderer

**설명**:

- gradient type mapping, radial/cone/rectangular gradient, pattern type off-by-one, angle 좌표계는 코드만으로 맞다고 보기 어렵습니다.

**권장 조치**:

- pattern 0..N, gradient type 전체, angle 0/45/90/135/임의각, center_x/center_y fixture를 추가합니다.
- legacy SVG/Canvas/HWP reference와 비교합니다.

**완료 메모**:

- native Skia-vs-layer-SVG 합성 pattern/gradient fixture를 추가했습니다.
- fixture는 pattern type 0..5, linear gradient angle 0/45/90/135/33, gradient type 2/3/4와 center_x/center_y offset을 포함합니다.
- SVG gradient replay가 type 3/4를 linear로 근사하던 부분을 Skia/Canvas와 같은 radial 계열 처리로 맞췄습니다.
- 실제 HWP reference와의 세부 의미 검증은 별도 corpus 확장으로 남깁니다.

---

### [TEST-009] resource/performance regression이 필요함

**심각도**: 중간  
**상태**: 완료
**근거 수준**: 제안  
**위치**: performance benchmark, resource cache tests

**설명**:

- 반복 이미지/수식/WMF/큰 페이지/많은 glyph run/긴 표 문서에서 decode 횟수와 렌더 시간을 추적해야 합니다.

**권장 조치**:

- 반복 이미지 100개, 반복 수식 100개, WMF 반복, 큰 페이지, 많은 glyph run, 긴 표 문서 benchmark를 추가합니다.
- decoded image/SVG/equation cache 도입 후 회귀 기준으로 사용합니다.

**완료 메모**:

- native Skia replay context에 반복 resource cache regression을 추가했습니다.
- 같은 image resource, SVG resource, SVG fragment를 100회 반복 조회해도 decoded/rasterized cache가 각각 1개 엔트리로 유지되는지 확인합니다.
- 실제 렌더 시간 benchmark와 긴 표/많은 glyph run/WMF corpus 측정은 별도 성능 벤치 확장으로 남깁니다.

---

### [TEST-010] feature matrix CI가 필요함

**심각도**: 중간  
**상태**: 완료
**근거 수준**: 제안  
**위치**: CI, Cargo feature matrix, wasm build

**설명**:

- `native-skia`가 optional feature로 묶여 있으므로 feature별 build break를 CI에서 잡아야 합니다.

**권장 조치**:

- 최소 조합으로 default, `--features native-skia`, wasm32 build, no-default-features, screenshot regression을 CI에 추가합니다.

**완료 메모**:

- 기존 CI는 default build/test, all-features/native-skia test, studio WASM build, full renderer sweep을 이미 갖고 있습니다.
- `ci.yml`에 `feature-matrix` job을 추가해 default lib, no-default-features lib, wasm32 lib check를 PR/push 경로에서 확인합니다.
- native-skia screenshot regression은 기존 all-features job과 workflow_dispatch full renderer sweep 경로를 유지합니다.

---

## Documentation And Policy

### [DOC-001] legacy/new backend의 canonical 경계 문서화가 필요함

**심각도**: 중간  
**상태**: 완료
**근거 수준**: 제안  
**위치**: README, renderer docs, WASM API docs

**설명**:

- README는 legacy SVG + layer replay, PageRenderTree -> PageLayerTree -> backend replay, Canvas2D + CanvasKit, Native Skia PNG 방향을 설명합니다.
- 하지만 실제 API 사용자는 legacy RenderBackend와 신규 layered backend 중 어느 경로가 canonical인지 헷갈릴 수 있습니다.

**영향**:

- 신규 기능이 legacy path에만 들어가거나, 반대로 layer path만 고쳐 실사용 Canvas2D 결과가 바뀌지 않는 혼란이 생길 수 있습니다.

**권장 조치**:

- README/API docs에 canonical render path, fallback/debug path, export-only path를 명시합니다.
- `renderPageToCanvas` 전환 계획과 compatibility policy를 문서화합니다.

**완료 메모**:

- README/README_EN에 canonical render path를 `PageRenderTree -> PageLayerTree -> backend replay`로 명시했습니다.
- `renderPageToCanvas`는 layered Canvas2D replay를 사용하고, legacy direct Canvas/SVG/HTML renderer는 compatibility/debug path임을 문서화했습니다.
- 신규 시각 의미는 `PaintOp` 또는 shared layer policy로 먼저 낮춘 뒤 backend가 replay해야 한다는 compatibility policy를 추가했습니다.

---

### [DOC-002] 새 렌더링 코드에는 더 엄격한 lint policy가 필요함

**심각도**: 낮음  
**상태**: 제안  
**근거 수준**: 제안  
**위치**: `Cargo.toml`, paint/skia modules, CI lint profile

**설명**:

- 프로젝트 전체에서 `dead_code`, `unused_variables`, `unused_imports` 등을 allow하는 것은 큰 코드베이스 전환기에는 이해되지만, 새 paint/skia 모듈에서는 누락 필드와 미사용 effect를 빨리 잡기 어렵습니다.

**권장 조치**:

- 새 paint/skia 모듈에 한해 `#![deny(...)]` 또는 별도 clippy CI profile을 둡니다.
- 특히 IR 필드가 backend/export에서 사용되지 않는 경우를 빠르게 감지하도록 합니다.
