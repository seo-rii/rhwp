# RHWP Layered Renderer Architecture

## 1. 목적

이 문서는 현재 rhwp의 멀티 렌더러 구조를 구현 기준으로 설명한다.
특히 다음 내용을 정리한다.

- `PageRenderTree`와 `PageLayerTree`의 역할 차이
- legacy SVG, layer SVG, browser Canvas2D, browser CanvasKit, native Skia의 현재 관계
- CanvasKit compat/default mode의 의미
- 스크린샷 diff 기반 parity 테스트 전략
- 새 백엔드나 새 paint op를 추가할 때 수정해야 하는 지점

상위 수준의 역사적 설계 배경은 [rendering_engine_design.md](./rendering_engine_design.md)를 본다.

## 2. 현재 렌더링 경로 한눈에 보기

rhwp는 더 이상 “하나의 render tree를 각 백엔드가 직접 해석”하는 구조만으로 설명되지 않는다.
현재는 두 단계의 표현을 사용한다.

```text
Document / Section / Paragraph / Control
  -> compose / paginate / layout
  -> PageRenderTree
  -> LayerBuilder
  -> PageLayerTree
  -> backend replay
```

실제 경로는 백엔드마다 다음과 같이 나뉜다.

| 경로 | 입력 | 주요 구현 파일 | 현재 역할 |
|---|---|---|---|
| Legacy SVG | `PageRenderTree` | `src/document_core/queries/rendering.rs`, `src/renderer/svg.rs` | 기존 기준 경로, 구조 비교 baseline |
| Layer SVG | `PageLayerTree` | `src/paint/*`, `src/renderer/svg_layer.rs` | layered replay 검증 경로 |
| Browser Canvas2D | `PageLayerTree` | `src/wasm_api.rs`, `rhwp-studio/src/view/page-renderer.ts`, `rhwp-studio/src/view/canvas2d-layer-renderer.ts` | layered 웹 baseline 렌더러 |
| Browser CanvasKit | `PageLayerTree` | `src/wasm_api.rs`, `rhwp-studio/src/view/canvaskit-renderer.ts` | layered browser backend |
| Native Skia | `PageLayerTree` | `src/renderer/skia/renderer.rs` | layered raster backend |

핵심 포인트는 다음 세 가지다.

1. browser Canvas2D와 CanvasKit은 이제 둘 다 `PageLayerTree`를 소비한다.
2. legacy `renderPageToCanvas()` / `web_canvas.rs` 경로는 studio의 기본 렌더러가 아니라, 하위 호환성 API로 남아 있다.
3. layer SVG와 native Skia도 같은 `PageLayerTree`를 소비한다.

즉 현재 구조는 “모든 출력이 하나의 구현체를 쓴다”는 뜻은 아니지만,
적어도 새 멀티 백엔드 경로는 browser Canvas2D / CanvasKit / layer SVG / native Skia가
같은 `PageLayerTree` 입력으로 수렴한 상태다.

또 하나 중요한 점은, 현재 공통 계약이 완전히 하나로 닫혀 있지는 않다는 것이다.

- `LayerRenderer` trait는 layered SVG처럼 stateful output을 누적하는 scene renderer 계약이다.
- `LayerRasterRenderer` trait는 native Skia처럼 PNG 바이트를 직접 내보내는 raster exporter 계약이다.

즉 “모든 layered backend가 하나의 단일 trait로 닫혔다”기보다는,
“공통 입력 IR은 `PageLayerTree`로 정리했고, 출력 계약은 scene renderer / raster exporter로 나눠 명시했다”라고 보는 편이 정확하다.

## 3. 왜 `PageLayerTree`가 필요했는가

`PageRenderTree`는 레이아웃 결과를 표현하기에는 적절하지만, 백엔드 replay용 IR로는 너무 semantic하다.
예를 들어 `Header`, `Footer`, `Table`, `TextLine`, `TextBox`, `Group` 같은 문서적 개념이 포함되어 있고,
backend마다 이를 다시 해석해야 한다.

이 구조는 다음 문제를 만든다.

- 새 raster/vector backend를 추가할 때 semantic container 해석을 다시 구현해야 한다.
- SVG/Canvas/Skia 간 합성 순서와 clip/transform 처리를 동일하게 맞추기 어렵다.
- browser CanvasKit과 native Skia가 같은 입력을 소비하지 못한다.

`PageLayerTree`는 이 문제를 해결하기 위해 도입되었다.

- semantic container를 시각 레이어 단위로 내린다.
- backend가 실제로 필요한 정보만 남긴다.
- clip, group, leaf paint op를 명시적으로 표현한다.
- backend는 layout이 아니라 replay에만 집중한다.

`src/paint/mod.rs`가 이 계층의 진입점이고, `src/paint/builder.rs`의 `LayerBuilder`가
`PageRenderTree -> PageLayerTree` 변환을 담당한다.

## 4. `PageRenderTree`와 `PageLayerTree`의 역할

| 항목 | `PageRenderTree` | `PageLayerTree` |
|---|---|---|
| 주 목적 | 레이아웃 결과 표현 | backend replay 입력 |
| 포함 정보 | 문서 의미 + 레이아웃 결과 | 시각 합성 정보 |
| 노드 성격 | semantic container + leaf | group / clip / leaf op |
| 대표 타입 | `RenderNodeType::Table`, `TextLine`, `Group` | `LayerNodeKind::Group`, `ClipRect`, `Leaf` |
| 소비자 | legacy SVG, 디버그/쿼리 계층 | layer SVG, native Skia, CanvasKit |
| backend 재해석 필요성 | 높음 | 낮음 |

실무적으로는 아래처럼 생각하면 된다.

- `PageRenderTree`는 “문서가 어떻게 조판되었는가”를 설명한다.
- `PageLayerTree`는 “그 결과를 어떤 순서로 어떻게 그릴 것인가”를 설명한다.

## 5. Layered path의 핵심 규칙

### 5.1 layout은 한 번만 한다

backend가 텍스트 줄바꿈, 문단 조판, 표 배치, 도형 내부 레이아웃을 다시 계산하면 안 된다.
그 책임은 `compose / paginate / layout` 단계에 있다.

### 5.2 backend는 replay만 한다

backend는 다음만 담당해야 한다.

- paint op 순서 재생
- clip 적용
- transform 적용
- raster/vector 출력
- browser-specific fallback 또는 compat 처리

### 5.3 semantic 정보는 필요한 만큼만 남긴다

`GroupKind`, `ClipKind`, `CacheHint` 같은 메타데이터는 남기되,
문서 의미를 backend가 다시 해석해야 할 정도로 semantic 정보를 넣지는 않는다.

### 5.4 shape 자식은 보존되어야 한다

shape 자체가 leaf paint op를 가지더라도, 그 안의 이미지 채우기, 글상자 텍스트, 그룹 내부 자식은
layer tree에서 사라지면 안 된다.

이 점은 layered path에서 중요한 invariant다.
최근 `group-drawing-02` parity 이슈도 shape leaf를 내리면서 자식을 버리면 안 된다는 점을 다시 확인한 사례다.

## 6. 백엔드별 현재 동작

### 6.1 Legacy SVG

- 진입점: `DocumentCore::render_page_svg_legacy_native()`
- 구현: `src/renderer/svg.rs`
- 입력: `PageRenderTree`

이 경로는 완전히 제거된 것이 아니라, layered path와의 구조 비교 기준으로 계속 남아 있다.
`RHWP_RENDER_PATH=layer-svg`를 지정하지 않으면 기본적으로 이 경로가 SVG 내보내기에 사용된다.

### 6.2 Layer SVG

- 진입점: `DocumentCore::render_page_svg_layer_native()`
- 구현: `src/renderer/svg_layer.rs`
- 입력: `PageLayerTree`

`SvgLayerRenderer`는 현재 `PageLayerTree`를 직접 순회하며 SVG를 재생한다.
초기 단계의 temporary render tree bridge는 제거되었고, clip/group/leaf op를
직접 SVG 출력으로 내리는 구조다.
다만 text/path/image 같은 primitive emission 일부는 `src/renderer/svg.rs`와
같은 lower-level SVG 출력 규칙을 공유한다.

### 6.3 Browser Canvas2D

- 진입점: `PageRenderer.renderPage()`에서 `this.wasm.getPageLayerTree(...)`
- 구현: `rhwp-studio/src/view/canvas2d-layer-renderer.ts`
- 입력: `PageLayerTree`

현재 브라우저에서의 baseline이다.
CanvasKit parity 테스트도 이 경로의 스크린샷을 기준으로 비교한다.

중요한 점은 Canvas2D도 이제 layered path로 전환되었다는 것이다.
즉 현재 CanvasKit parity는 “같은 `PageLayerTree`를 두 browser backend가 replay하는 sibling test”에 가깝다.

기존 `renderPageToCanvas()` / `src/renderer/web_canvas.rs` 경로는 완전히 삭제하지 않았지만,
studio의 기본 페이지 렌더링에서는 더 이상 사용하지 않는다.
browser E2E는 이 경로가 다시 호출되면 실패하도록 probe를 걸고 있다.

### 6.4 Browser CanvasKit

- 진입점: `PageRenderer.renderPage()`에서 `this.wasm.getPageLayerTree(...)`
- 구현: `rhwp-studio/src/view/canvaskit-renderer.ts`
- 입력: `PageLayerTree`

CanvasKit은 browser-side replay renderer다.
Rust core가 layout과 layer tree export를 담당하고, TypeScript가 CanvasKit API 호출로 이를 그린다.

이 경로를 둔 이유는 다음과 같다.

- native Skia와 유사한 2D drawing model 확보
- 브라우저에서 Skia 계열 renderer 실험
- 추후 native/backend 확장성 확보

### 6.5 Native Skia

- 진입점: `DocumentCore::render_page_png_native()`
- 구현: `src/renderer/skia/renderer.rs`
- feature: `native-skia`
- 입력: `PageLayerTree`

native Skia는 non-wasm 타깃에서 layered raster backend 역할을 한다.
현재는 테스트/검증용 경로가 중심이며, 별도의 일반 사용자용 `export-png` CLI는 아직 없다.

### 6.6 RenderProfile 기본값

`RenderProfile`은 layered 출력 경로가 어떤 품질/캐시 힌트를 기본으로 택할지 나타내는 enum이다.
이 값은 이제 `PageLayerTree` JSON 경계에도 `profile` 필드로 함께 직렬화된다.
즉 browser backend도 단순히 `cacheHint`만 보는 것이 아니라, Rust가 선택한 출력 profile 자체를 확인할 수 있다.

| 경로 | 기본 profile |
|---|---|
| browser layer tree (`getPageLayerTree`) | `Screen` |
| layer SVG export | `Print` |
| native Skia PNG | `HighQuality` |

추가로 `RHWP_RENDER_PROFILE` 환경 변수로 `screen`, `print`, `high-quality`, `fast-preview`를 지정해
기본값을 덮어쓸 수 있다.

browser studio 쪽에서는 `?renderProfile=screen|print|high-quality|fast-preview` query parameter와
localStorage를 통해 이 값을 명시적으로 선택할 수 있다.
이때 `WasmBridge.getPageLayerTree(page, profile)`는 해당 profile로 layer tree를 다시 요청한다.

현재 `FastPreview`는 page background 쪽 cache hint만 다르게 적용하며,
더 적극적인 preview simplification을 위한 예약 성격이 강하다.

이 cache hint는 `PageLayerTree` JSON에도 함께 직렬화된다.
browser backend는 Rust가 계산한 `cacheHint`를 관찰할 수 있고,
CanvasKit은 현재 image downscale 시 mipmap 사용 여부를 profile과 render mode에 따라 달리 고른다.

## 7. CanvasKit render mode

CanvasKit에는 현재 두 가지 모드가 있다.

| 모드 | 의미 | 기본값 |
|---|---|---|
| `default` | direct CanvasKit/Skia replay 우선 | 기본 |
| `compat` | Canvas2D 기준에 가까운 보수적 CanvasKit direct replay policy | 아님 |

`rhwp-studio/src/view/render-backend.ts`에서 query param과 localStorage를 통해 이 값을 결정한다.
같은 파일에서 layered `renderProfile`도 함께 관리한다.

`default`가 기본인 이유는 다음과 같다.

- CanvasKit을 browser Canvas2D-assisted preview가 아니라 native Skia로 이어지는 독립 replay backend로 키우기 위해서다.
- 지원 가능한 raster image, equation/form object, text effect replay는 Canvas2D overlay 없이 CanvasKit 경로에서 직접 처리해야 한다.
- direct replay가 기존 Canvas2D와 의도적으로 다르면 fixture와 diagnostics에서 `Skia strict replay improvement`로 구분한다.

`compat` mode는 사용자가 명시적으로 선택한 안정성 모드다.
이 모드도 Canvas2D overlay를 사용하지 않는다. 대신 CanvasKit 내부에서 더 보수적인
variant selection, image sampling, cache policy 같은 직접 replay 정책을 선택한다.
지원하지 않는 선택지는 Canvas2D paint를 덧씌우는 대신 TextRun fallback이나
deterministic reject diagnostics로 처리한다. 이 로직은 browser-specific policy layer이며,
Rust core의 layout 자체를 바꾸는 것은 아니다.

CanvasKit surface backend는 render mode와 별도의 진단 축이다.
`canvaskitMode`는 query param과 localStorage로 유지되지만,
`canvaskitSurface`는 테스트/진단용 query-only override로 유지한다.

| surface 값 | 의미 |
|---|---|
| `auto` | 기본. 명시적으로 `MakeWebGLCanvasSurface`를 먼저 시도하고 실패하면 `MakeSWCanvasSurface`로 fallback |
| `webgl` | WebGL surface 경로를 우선 검증. 실패하면 software fallback |
| `software` | WebGL surface 생성을 생략하고 software surface만 사용 |

renderer는 surface preference, 실제 선택된 surface helper, WebGL/software attempt/fallback 횟수를 diagnostics로 노출한다.
이 값은 CanvasKit이 어떤 helper path로 surface를 만들었는지 검증하기 위한 것이며,
future native parity 점검에서는 `software` 모드가 browser GPU 차이를 줄이는 기준점이 된다.

CanvasKit package에는 WebGPU API/type surface가 존재하지만 rhwp는 아직 WebGPU를 적용하지 않는다.
WebGPU는 async GPU device/context lifecycle과 CanvasKit 초기화 계약을 별도로 잡아야 하므로,
현재 browser CanvasKit backend의 기본 목표는 WebGL/software surface에서 Canvas2D overlay 없이 `PageLayerTree`를 직접 replay하는 것이다.

## 8. Parity와 diff 전략

렌더러 parity는 “무조건 exact diff 0”만으로 관리하지 않는다.
backend 특성상 anti-aliasing, subpixel coverage, font rasterization 차이가 생길 수 있기 때문이다.

현재 검증 전략은 다음과 같다.

### 8.1 Legacy SVG vs Layer SVG

- 성격: 구조 전환 검증
- 기준: exact match 중심
- 산출물: `output/layer-svg-diff/`

### 8.2 Layer SVG vs Native Skia PNG

- 성격: layered raster backend 검증
- 기준: tolerant diff pixel budget 사용
- 산출물: `output/skia-diff/`

### 8.3 Browser Canvas2D vs CanvasKit

- 성격: browser parity 검증
- 테스트 파일: `rhwp-studio/e2e/canvaskit-render.test.mjs`
- 기준:
  - exact diff는 항상 기록
  - tolerant diff는 채널 차이 `8` 이하 픽셀을 무시
  - 최종 pass/fail은 tolerant diff ratio `0.25%` 이하
- 산출물:
  - `output/e2e/`
  - `rhwp-studio/e2e/screenshots/`

이 전략의 의도는 다음과 같다.

- exact diff는 계속 남겨서 변화량을 추적한다.
- 하지만 통과 기준은 renderer 엔진 차이만 허용하는 tolerant 값으로 잡는다.
- 즉 “눈에 띄는 구조 차이”와 “작은 raster 차이”를 구분한다.

현재 이 비교는 “legacy Canvas vs layered CanvasKit”이 아니라,
“layered Canvas2D vs layered CanvasKit” 비교라는 점이 중요하다.

## 9. 테스트가 보호해야 하는 것

현재 parity 테스트는 단순 픽셀 비교가 아니라 layered architecture의 invariant를 지키는 장치다.

특히 다음 문제를 잡아내야 한다.

- shape leaf를 만들면서 shape 자식을 누락하는 경우
- group/clip 계층이 flatten되면서 draw order가 바뀌는 경우
- CanvasKit에서 텍스트 fallback이 빠져 한글/수식이 깨지는 경우
- equation, crop, field, group drawing처럼 backend 차이가 잘 드러나는 샘플 회귀

즉 스크린샷 테스트는 “예쁘게 보이는지” 이상의 의미를 가진다.
현재 layered path가 backend별로 같은 `PageLayerTree`를 얼마나 일관되게 replay하는지 보여주는 계약 테스트다.

## 10. 새 backend를 추가할 때의 작업 순서

새 backend를 붙일 때는 보통 아래 순서를 따른다.

1. `PageLayerTree`를 입력으로 받을지 먼저 결정한다.
2. `LayerNodeKind::Group / ClipRect / Leaf` replay 전략을 정의한다.
3. 필요한 `PaintOp`를 backend별 draw call로 매핑한다.
4. browser backend면 `paint/json.rs`와 TS 타입까지 같이 맞춘다.
5. 기존 baseline과의 parity 테스트를 추가한다.

수정 지점은 대체로 다음 파일들이다.

| 목적 | 주요 파일 |
|---|---|
| layer tree 생성 | `src/paint/builder.rs` |
| layer tree JSON export | `src/paint/json.rs` |
| layered SVG replay | `src/renderer/svg_layer.rs` |
| native Skia replay | `src/renderer/skia/renderer.rs` |
| wasm export | `src/document_core/queries/rendering.rs`, `src/wasm_api.rs` |
| browser CanvasKit replay | `rhwp-studio/src/view/canvaskit-renderer.ts` |
| browser parity test | `rhwp-studio/e2e/canvaskit-render.test.mjs` |

## 11. 새 paint op를 추가할 때의 체크리스트

새 `PaintOp`를 추가하면 보통 아래를 같이 확인해야 한다.

1. `src/paint/paint_op.rs`에 타입 추가
2. `src/paint/builder.rs`에서 해당 render node를 layer op로 변환
3. `src/paint/json.rs` 직렬화 추가
4. `src/renderer/svg_layer.rs` replay 경로 반영
5. `src/renderer/skia/renderer.rs` replay 경로 반영
6. browser에서 쓰면 TS layer type + CanvasKit replay 반영
7. parity test 샘플 추가

이 중 하나라도 빠지면 “특정 backend에서만 안 보임” 같은 비대칭 문제가 쉽게 생긴다.

## 12. 현재 구조를 해석할 때 주의할 점

### 12.1 Canvas2D와 CanvasKit은 입력은 대칭이지만 구현은 다르다

Canvas2D와 CanvasKit은 이제 둘 다 layered browser path이고,
같은 `PageLayerTree`를 입력으로 받는다.

다만 둘은 같은 renderer 구현체가 아니라,
Canvas2D는 DOM Canvas 2D replay이고 CanvasKit은 Skia API replay다.
따라서 anti-aliasing, glyph rasterization, stroke join 같은 세부 동작은 여전히 다를 수 있다.

### 12.2 Layered path가 semantic tree를 완전히 대체한 것은 아니다

legacy SVG와 여러 query/debug 기능은 여전히 `PageRenderTree`에 기대고 있다.
따라서 현재는 “semantic tree 제거”가 아니라 “layered replay를 병행 도입”한 단계다.

### 12.3 compat 코드는 backend 불일치를 숨기는 완충층이다

compat mode는 아키텍처 오염이라기보다,
현재 baseline을 보존하면서 새 backend를 도입하기 위한 전환 비용으로 보는 편이 맞다.

다만 이 코드는 가능한 한 `rhwp-studio` 쪽 browser layer에만 머물러야 하고,
Rust layout core로 역류하면 안 된다.

## 13. 요약

현재 rhwp의 layered renderer 구조는 다음으로 요약할 수 있다.

- layout 결과는 `PageRenderTree`로 만들어진다.
- backend replay용 시각 IR은 `PageLayerTree`다.
- layer SVG, native Skia, browser Canvas2D, browser CanvasKit은 `PageLayerTree`를 공유한다.
- studio의 브라우저 baseline도 이제 layered Canvas2D다.
- browser parity 테스트는 같은 layer tree를 두 browser backend가 얼마나 비슷하게 replay하는지를 검증한다.
- 새 backend를 추가할 때 가장 중요한 원칙은 “layout을 다시 하지 말고 layer tree를 replay하라”이다.

## 14. 아키텍처를 완성하려면 남은 작업

현재 구조는 “새 backend가 공통 `PageLayerTree`를 replay한다”는 목표까지는 도달했지만,
아래 작업이 남아 있다.

1. `svg_layer.rs`의 transition bridge를 더 줄여서 `PageRenderTree` 재조립 의존을 단계적으로 걷어내기
2. `ResourceArena`를 실제 shared image/font/pattern resource cache로 채워 backend replay 중복을 줄이기
3. `RenderProfile`과 `CacheHint`를 SVG/Skia/browser backend가 실제 품질 분기와 캐시 정책에 쓰도록 관통시키기
4. native raster export와 browser replay 경로의 공통 계약을 더 정리해 새 backend 추가 시 진입점이 흔들리지 않게 만들기
5. CanvasKit 쪽 page-layer cache, JSON 경계 축소, WebGPU 적용 여부 같은 성능 후속 작업 마무리하기
6. CI에서 native Skia, layered browser parity, representative screenshot sweep를 항상 자동 검증하도록 유지하기

즉 현재 단계는 “layered 멀티 백엔드의 골격은 완성”된 상태이고,
남은 일은 bridge 축소, 공용 resource/runtime 정리, 성능/검증 자동화 강화라고 보는 편이 정확하다.
