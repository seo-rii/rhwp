# Contributing to rhwp

rhwp에 관심을 가져주셔서 감사합니다!

"모두의 한글"은 이름 그대로 모두의 참여로 완성됩니다. 코드 기여, 버그 리포트, 문서 개선, HWP 샘플 파일 제공 — 어떤 형태든 환영합니다.

## 처음 참여하시나요?

### 1. 프로젝트 체험하기

코드를 보기 전에 먼저 사용해보세요:

- **[온라인 데모](https://edwardkim.github.io/rhwp/)** — 브라우저에서 바로 HWP 파일 열기
- **[VS Code 확장](https://marketplace.visualstudio.com/items?itemName=edwardkim.rhwp-vscode)** — VS Code에서 HWP 미리보기
- **[npm 패키지](https://www.npmjs.com/package/@rhwp/editor)** — 3줄로 HWP 에디터 임베드

### 2. 개발 환경 설정 (5분)

```bash
# 클론
git clone https://github.com/edwardkim/rhwp.git
cd rhwp

# 빌드 + 테스트
cargo build
cargo test

# 웹 에디터 실행 (선택)
cd rhwp-studio
npm install
npx vite --port 7700
# http://localhost:7700 에서 확인
```

### 3. 첫 기여 찾기

- [`good first issue`](https://github.com/edwardkim/rhwp/labels/good%20first%20issue) 라벨이 붙은 이슈
- 렌더링 불일치 제보 (한컴과 비교하여 스크린샷 첨부)
- 문서 오타/개선
- [Discussions](https://github.com/edwardkim/rhwp/discussions)에서 질문/아이디어 제안

## 기여 방법

### 버그 리포트

HWP 파일이 한컴과 다르게 렌더링되면 알려주세요:

1. [이슈 생성](https://github.com/edwardkim/rhwp/issues/new?template=bug_report.md)
2. **한컴 스크린샷** + **rhwp 스크린샷** 비교 첨부
3. 가능하면 HWP 파일 첨부 (개인정보 제거 후)

디버깅 정보를 함께 제공하면 수정이 빨라집니다 (아래 "디버깅 가이드" 참고).

### 코드 기여 — Fork & PR 워크플로우

컨트리뷰터는 **Fork 기반**으로 작업합니다. 저장소에 직접 push할 수 없으며, PR을 통해 코드를 제출합니다.

```
[본인 Fork]                              [edwardkim/rhwp]

1. Fork (GitHub UI)
   edwardkim/rhwp → myid/rhwp

2. Clone
   git clone https://github.com/myid/rhwp.git
   cd rhwp

3. 브랜치 생성 + 작업
   git checkout -b fix/issue-123
   (코드 수정 + 테스트)

4. Push (본인 Fork에)
   git push origin fix/issue-123

5. PR 생성 (GitHub UI)                   ──→ devel 브랜치로 PR
                                              CI 자동 실행 (빌드+테스트+all-features Clippy+studio E2E)
                                              메인테이너 코드 리뷰
                                              승인 후 merge
```

**중요:**
- PR 대상 브랜치는 **`devel`** 입니다 (`main` 아님)
- PR을 생성하면 CI가 기본 빌드/테스트, `all-features` Clippy/native-skia 경로, studio headless E2E를 자동으로 실행합니다
- CI가 통과하지 않으면 merge할 수 없습니다
- 메인테이너의 코드 리뷰 승인 후 merge됩니다

### PR 전 체크리스트

먼저 작업 브랜치를 최신 `devel` 기준으로 맞추세요.

```bash
git fetch upstream devel
git rebase upstream/devel
```

```bash
cargo test                                       # 793+ 테스트 통과
cargo clippy --all-targets --all-features        # native-skia까지 확인하려면 fontconfig/freetype 개발 패키지가 필요할 수 있음
```

렌더러/시각 회귀를 건드린 PR이면 아래도 같이 확인해 주세요.

```bash
cargo test --all-targets --features native-skia

cd rhwp-studio
npm run e2e:ci
```

또한 렌더러 PR은 Ready for Review로 바꾸기 전에 아래 정보를 본문에 남기는 편이 좋습니다.

- 비교 스크린샷 또는 diff artifact 경로
- 아직 남아 있는 known diff 목록
- 직접 실행한 테스트 명령과 결과
- `compat` / `default` 같은 렌더 모드 차이가 있으면 어떤 기준으로 검증했는지

### HWP 샘플 파일 제공

다양한 HWP 파일로 테스트할수록 렌더링 품질이 올라갑니다. 개인정보가 없는 공공 문서나 테스트용 파일을 제공해주시면 큰 도움이 됩니다.

## 브랜치 규칙

| 브랜치 | 용도 | 보호 규칙 |
|--------|------|----------|
| `main` | 릴리즈 (안정 버전) | PR 필수 + CI 통과 + 리뷰 1명 |
| `devel` | 개발 통합 (PR 대상) | CI 통과 필수 |

- 컨트리뷰터 PR → `devel`
- 릴리즈 시 `devel` → `main` + 태그

## 디버깅 가이드

렌더링 버그를 조사할 때 코드 수정 없이 사용할 수 있는 3종 도구:

```bash
# 1. 문단/표 식별 (디버그 오버레이)
cargo run --bin rhwp -- export-svg sample.hwp --debug-overlay

# 2. 페이지 배치 목록
cargo run --bin rhwp -- dump-pages sample.hwp -p 3

# 3. 특정 문단 상세 (ParaShape, LINE_SEG, 표 속성)
cargo run --bin rhwp -- dump sample.hwp -s 0 -p 45
```

`export-svg`의 기본 출력 폴더는 `output/`입니다. 예를 들어 `sample.hwp`를 한 페이지 문서로 내보내면 `output/sample.svg`, 여러 페이지면 `output/sample_001.svg`처럼 저장됩니다. `-o`를 사용하면 다른 폴더로 보낼 수 있습니다.

### 렌더러 비교 가이드

현재 렌더러 경로는 아래처럼 나뉩니다.

- **Legacy SVG**: 기본 `cargo run --bin rhwp -- export-svg sample.hwp`
- **Layer SVG**: `RHWP_RENDER_PATH=layer-svg cargo run --bin rhwp -- export-svg sample.hwp`
- **Native Skia PNG**: `cargo run --features native-skia --bin rhwp -- export-png sample.hwp`
- **Browser Canvas2D / CanvasKit**: `rhwp-studio`에서 기본은 layered Canvas2D, `http://localhost:7700/?renderer=canvaskit`로 CanvasKit 비교
  - CanvasKit 래스터 모드: `?canvaskitMode=default`(기본, direct Skia replay 우선) 또는 `?canvaskitMode=compat`(전환기 Canvas2D overlay fallback 허용)
  - CanvasKit surface 선택: `?canvaskitSurface=auto`(기본, WebGL surface 후 software fallback), `?canvaskitSurface=webgl`(WebGL 우선), `?canvaskitSurface=software`(WebGL 생성 생략). 이 값은 진단/검증용 query-only override이며 localStorage에 저장하지 않습니다.
  - 두 browser backend는 모두 `getPageLayerTree()`를 통해 같은 `PageLayerTree`를 replay합니다. 예전 `renderPageToCanvas()` 경로는 하위 호환용으로만 남아 있습니다.

레이어 기반 출력은 `RHWP_RENDER_PROFILE`로 기본 프로파일을 덮어쓸 수 있습니다.

- 기본값은 경로별로 다릅니다: browser layer tree는 `screen`, layer SVG export는 `print`, native Skia PNG는 `high-quality`
- 허용 값: `screen`, `print`, `high-quality`, `fast-preview`
- `fast-preview`는 현재 page background cache hint만 다르게 주며, 더 공격적인 단순화 프로파일을 위한 예약값입니다.

SVG를 직접 비교하려면 보통 아래처럼 두 번 내보냅니다.

```bash
cargo run --bin rhwp -- export-svg sample.hwp -o output/legacy
RHWP_RENDER_PATH=layer-svg cargo run --bin rhwp -- export-svg sample.hwp -o output/layer
cargo run --features native-skia --bin rhwp -- export-png sample.hwp -o output/skia
```

자동 회귀 테스트는 다음 명령을 사용합니다.

```bash
cargo test layer_svg --lib
RUSTFLAGS='-L native=target/native-libs' cargo test skia --lib --features native-skia
cargo test-skia-full-sweep              # native Skia vs layer SVG 전체 sample corpus

cd rhwp-studio
npm run e2e                           # 기본: host Chrome CDP 모드, CanvasKit compat/default 둘 다 실행
npm run e2e:headless                  # headless Chrome 모드
npm run e2e:ci                        # Vite 서버 자동 기동 + headless Chrome 전체 묶음
npm run e2e:ci:full                   # Vite 서버 자동 기동 + browser full sample corpus

cd ..
python3 scripts/renderer_baseline.py  # manifest 기준 legacy/layer/skia/canvas2d/canvaskit baseline 고정
python3 scripts/renderer_baseline.py --profiles screen,print,high-quality,fast-preview
```

WSL/CI처럼 호스트 Chrome CDP가 없는 환경에서는 `npm run e2e` 대신 `npm run e2e:headless` 또는 `npm run e2e:ci`를 사용하세요.

기준선 manifest는 `scripts/renderer_baseline_manifest.json`에 있습니다. 기본 출력은 `output/renderer-baseline/latest/`이며, filtered manifest / backend별 산출물 / markdown+json 보고서를 함께 남깁니다. layered profile 축까지 고정하려면 `--profiles screen,print,high-quality,fast-preview`처럼 명시하면 됩니다. browser baseline PNG와 layer/native 산출물 경로에는 profile suffix가 붙습니다.

비교 아티팩트는 아래 위치에 남습니다.

- `output/layer-svg-diff/` — legacy SVG vs layer SVG
- `output/skia-diff/` — layer SVG vs native Skia PNG
- `output/e2e/` 및 `rhwp-studio/e2e/screenshots/` — 브라우저 Canvas2D vs CanvasKit

- `layer-svg` 비교는 현재 exact match 기준입니다. 한 픽셀이라도 diff가 생기면 테스트가 실패합니다.
- `native-skia` / `CanvasKit` 비교는 exact diff를 계속 저장하고, 별도로 채널 차이가 `8` 이하인 픽셀을 무시한 tolerant diff를 계산합니다.
- `native-skia`는 추가로 `1px neighborhood`를 고려한 `raster-tolerant diff`와, 거의 흰색인 안티앨리어싱 커버리지를 접고 실제 잉크 모양만 비교하는 `ink-mask diff`도 계산합니다.
- `CanvasKit`도 추가로 `ink-mask diff`를 계산합니다. exact/raw tolerant diff 아티팩트는 계속 저장하고, 최종 통과 여부는 `tolerant budget`과 `ink-mask budget`을 동시에 만족하는지로 판단합니다.
- 현재 기준은 `native-skia`는 `ink-mask diff ratio 0.30%` 이하이며, `CanvasKit`은 기본 `tolerant diff ratio 0.25%` 이하 + `ink-mask diff ratio 0.01%` 이하입니다. 일부 샘플은 이미지/그룹 드로잉의 알려진 래스터 특성에 맞춰 더 좁은 per-case budget을 별도로 둡니다.
- `native-skia`의 `ink-mask diff`는 `white delta 25`, `alpha threshold 8`, `neighborhood radius 1px` 기준입니다. exact/raw tolerant/raster-tolerant 아티팩트는 계속 저장하고, 최종 실패 여부만 실제 잉크 모양 차이 기준으로 판정합니다.
- `CanvasKit`의 `ink-mask diff`도 동일하게 `white delta 25`, `alpha threshold 8`, `neighborhood radius 1px` 기준을 사용합니다.
- `CanvasKit` e2e는 기본적으로 전체 페이지를 비교합니다. `eq-01`도 다시 전체 페이지 회귀에 포함됩니다.
- 추가로 `equation`처럼 특정 op 자체를 분리해서 추적하고 싶은 기능 회귀는 해당 `layer op` bbox만 잘라서 비교합니다.
- browser E2E는 `canvas2d`가 다시 legacy `renderPageToCanvas()` 경로를 타면 실패하도록 probe를 둡니다.

디버그 오버레이는 문단/표에 라벨을 표시합니다:
- 문단: `s{섹션}:pi={인덱스} y={좌표}`
- 표: `s{섹션}:pi={인덱스} ci={컨트롤} {행}x{열} y={좌표}`

이 정보를 이슈에 첨부하면 버그 수정이 빨라집니다.

## 프로젝트 구조

```
src/
├── model/          ← 순수 데이터 구조 (의존성 없음)
├── parser/         ← HWP/HWPX 파일 → 모델 변환
├── document_core/  ← 편집 명령 + 조회 (CQRS)
├── renderer/       ← 레이아웃, 페이지네이션, SVG/Canvas
├── serializer/     ← 모델 → HWP 파일 저장
└── wasm_api.rs     ← WASM 바인딩

rhwp-studio/        ← 웹 에디터 (TypeScript + Vite)
```

의존성 방향: `model` ← `parser` ← `document_core` ← `renderer` ← `wasm_api`

## 코드 스타일

- `cargo clippy -- -D warnings` 경고 0건 (CI에서 강제)
- `unwrap()` 최소화
- 모든 문서는 한국어로 작성

## HWP 단위 참고

- 1 inch = 7,200 HWPUNIT
- 1 mm ≈ 283.465 HWPUNIT

## 소통

- **[Discussions](https://github.com/edwardkim/rhwp/discussions)** — 질문, 아이디어, 기술 토론
- **[Issues](https://github.com/edwardkim/rhwp/issues)** — 버그 리포트, 기능 요청

## Notice

본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.

## License

이 프로젝트는 [MIT License](LICENSE)로 배포됩니다. 기여하신 코드도 동일한 라이선스가 적용됩니다.
