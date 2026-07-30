# Renderer Baseline Workflow

이 문서는 layered renderer 전환 작업에서 비교 기준을 고정하기 위한 baseline 캡처 절차를 정리한다.

## 목적

전환기 구조를 정리하는 동안 "렌더링 결과가 개선된 것인지, 단순히 변형된 것인지"를 구분하려면
같은 샘플 집합을 여러 backend로 고정된 방식으로 반복 캡처할 수 있어야 한다.

현재 baseline은 아래 6개 경로를 한 번에 묶는다.

- legacy SVG
- layer SVG
- native Skia PNG
- browser Canvas2D
- browser CanvasKit compat
- browser CanvasKit default

## Manifest

기본 manifest는 `scripts/renderer_baseline_manifest.json`에 있다.

manifest는 "대표 샘플을 어떤 범주로 보고 추적할지"를 고정하는 용도다.
현재 기본 분류는 다음과 같다.

- `paragraph`
- `table`
- `image`
- `equation`
- `header-footer`
- `footnote`
- `group-drawing`
- `form`

샘플은 `id`, `file`, `category`, `page`, `notes`를 가진다.

## 실행

전체 baseline을 기본 manifest로 캡처:

```bash
python3 scripts/renderer_baseline.py
```

특정 샘플만 필터링:

```bash
python3 scripts/renderer_baseline.py --filter eq-01
python3 scripts/renderer_baseline.py --filter table --skip-browser
```

큰 corpus는 `--shard-index`와 `--shard-count`로 결정적으로 분할할 수 있다.
index는 0부터 시작하며 각 shard는 반드시 서로 다른 출력 디렉터리를 사용한다.

```bash
python3 scripts/renderer_baseline.py \
  --shard-index 0 --shard-count 4 \
  --output output/renderer-baseline/shard-0
python3 scripts/renderer_baseline.py \
  --shard-index 1 --shard-count 4 \
  --output output/renderer-baseline/shard-1
```

필터를 먼저 적용한 뒤 정규화된 `id`, `file`, `page` identity의 SHA-256
상위 64비트를 shard count로 나눈다. 따라서 manifest 순서를 바꾸어도 sample
assignment가 달라지지 않고, 같은 filter/count의 모든 index를 실행하면 중복이나
누락 없이 선택 집합 전체를 덮는다. Python driver와 standalone Node browser
capture가 같은 알고리즘을 사용하며, driver는 browser 결과의 sample ID 집합이
native 선택 집합과 다르면 실패한다. 선택된 shard와 알고리즘은 JSON/Markdown
report에 기록된다.

브라우저 캡처 모드는 `host` 또는 `headless`를 지원한다.

```bash
python3 scripts/renderer_baseline.py --browser-mode headless
```

CanvasKit surface 축은 기본적으로 `auto`다. WebGPU, WebGL, software surface를
명시적으로 검증하려면 아래처럼 지정한다.

```bash
python3 scripts/renderer_baseline.py --canvaskit-surface webgpu --filter equation --skip-native
RHWP_CANVASKIT_SURFACE=software python3 scripts/renderer_baseline.py --skip-native
```

허용 값은 `auto`, `webgpu`, `webgl`, `software`이며 `gpu`는 `webgpu`,
`sw`/`cpu`는 `software` alias로 처리한다. 생성되는 browser baseline,
native-vs-CanvasKit parity JSON, aggregate Markdown report는 surface 요청값과
CanvasKit surface fallback diagnostics를 보존한다.

## 출력 구조

기본 출력 위치는 `output/renderer-baseline/latest/`이다.

예시:

```text
output/renderer-baseline/latest/
  baseline-manifest.filtered.json
  baseline-report.json
  baseline-report.md
  paragraph-basic/
    legacy-svg/
    layer-svg/
    native-skia/
  browser/
    paragraph-basic/
      canvas2d.png
      canvaskit-compat.png
      canvaskit-default.png
      canvaskit-default-screen-webgpu.png
```

## 사용 원칙

1. 큰 layered refactor 전에 baseline을 먼저 저장한다.
2. 구조 변경 후 동일 manifest를 다시 돌린다.
3. diff나 시각적 어긋남이 생기면, baseline 보고서와 artifact 경로를 기준으로 원인을 좁힌다.

이 baseline은 "최종 품질 판정"이 아니라, transition hardening을 위한 공통 기준선이다.
정식 pass/fail 판정은 기존 regression test와 full sweep이 계속 담당한다.
