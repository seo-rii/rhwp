# 트러블슈팅: 탭+TAC 수식 겹침 문제 (#142, #159)

작성일: 2026-04-16

## 증상

exam_math.hwp 2페이지 6번 문항 선택지에서 ③ 원문자 위에 수식 `0`이 겹쳐 렌더링됨.

```
① -5    ② -√5    ③0    ④ √5    ⑤ 5
                   ↑ 겹침
```

## 조사 과정

### 1차 시도: 수식 TAC 너비 문제로 추정 (실패)

- `composer.rs`에서 수식 TAC 너비를 레이아웃 엔진 산출값으로 대체 → 효과 없음
- 원인: 탭이 수식 TAC 너비에 무관하게 고정 탭 스톱으로 점프하므로, TAC 너비가 원문자 간격에 영향 없음

### 2차 시도: 원문자 전각 폭 문제로 추정 (부분 효과)

- `is_fullwidth_symbol()`에 원문자(U+2460~) 범위 추가 → 간격 약간 변화하지만 겹침 미해결
- 원인: 내장 폰트 메트릭에 원문자가 없어 폴백은 적용되지만, 근본 원인이 아님

### 3차 시도: 탭 `/2.0` 문제로 추정 (분석)

- `style_resolver.rs:618`에서 탭 position을 `/2.0`으로 나누는 코드 발견
- 제거하면 간격 과다, 유지하면 불일치
- 한컴 격자 비교로 **`/2.0`이 올바른 변환**임을 확인 (HWP 탭 position이 실제 좌표의 2배로 저장)

### 4차 시도: est_x와 x의 불일치 추적 (핵심 접근)

- 정렬 계산(`est_x`)과 렌더링(`x`)의 초기값/누적값을 비교
- SVG 좌표 역산으로 `compute_char_positions`와 `estimate_text_width`의 결과가 다른 것을 발견

### 5차: 근본 원인 발견 ✅

디버그 출력 추가로 확인:
```
[RENDER_TAC] seg="\t③ " est_w=45.0 cp_last=61.7 inline_tabs=4
```

**`estimate_text_width`(45.0)와 `compute_char_positions`(61.7)의 탭 계산이 16.7px 차이!**

## 근본 원인

### `inline_tabs` 처리 누락

- `paragraph_layout.rs:1105`에서 렌더링 스타일에 `inline_tabs = tab_extended` 설정
- `compute_char_positions`는 `inline_tabs`가 있으면 **인라인 탭 경로** 사용
- `estimate_text_width`는 `inline_tabs`를 **무시**하고 **custom tabs 경로** 사용
- 두 경로의 탭 점프 결과가 다르므로, ③ 렌더링 위치와 수식 x 좌표가 불일치

### 영향

```
estimate_text_width: 탭 점프 = tab_stops 기반 → seg_w = 45.0px
compute_char_positions: 탭 점프 = inline_tabs 기반 → cp_last = 61.7px

수식 x = bbox.x + seg_w → ③ 글리프 안쪽에 배치 (겹침)
③ 렌더링 = bbox.x + char_positions[③] → 탭 점프 후 올바른 위치
```

## 수정

`text_measurement.rs`의 `EmbeddedTextMeasurer::estimate_text_width`에 `inline_tabs` 분기 추가:

```rust
if tab_char_idx < style.inline_tabs.len() {
    let ext = &style.inline_tabs[tab_char_idx];
    let tab_width_px = ext[0] as f64 * 96.0 / 7200.0;
    // compute_char_positions와 동일한 로직
    ...
}
```

정렬 계산(est_x)에서도 `ts.inline_tabs = composed.tab_extended.clone()` 추가.

## 검증

- `cargo test` 788개 전체 통과
- ③과 수식 `0`의 겹침 해소
- ③→④ 간격: 13.8mm → 18.3mm (한컴 17mm 대비 +1.3mm, 기준 ≤ 2mm PASS)

## 교훈

1. **같은 데이터를 다른 경로로 계산하는 코드는 반드시 동기화** — `compute_char_positions`와 `estimate_text_width`가 다른 탭 처리 로직을 사용하면 레이아웃이 어긋남
2. **디버그 출력으로 두 함수의 결과를 동시에 비교**하는 것이 가장 효과적인 진단 방법
3. **격자 오버레이 기능(#145)**이 한컴 비교에 큰 도움
