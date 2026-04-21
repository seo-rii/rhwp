## 변경 요약

이 PR이 해결하는 문제와 변경 내용을 간결하게 설명해주세요.

## 관련 이슈

closes #

## 테스트

- [ ] `cargo test` 통과
- [ ] 최신 `upstream/devel` 기준으로 브랜치 동기화 확인
- [ ] `cargo clippy --all-targets --all-features -- -D warnings` 통과
- [ ] 관련 샘플 파일로 SVG 내보내기 확인
- [ ] 웹(WASM) 렌더링 확인 (해당하는 경우)
- [ ] 렌더러 변경인 경우 `cargo test --all-targets --features native-skia` 확인
- [ ] 렌더러 변경인 경우 `cd rhwp-studio && npm run e2e:ci` 확인
- [ ] 렌더러 변경인 경우 known diff / tolerant 기준을 본문에 기록

## 스크린샷

변경 전후 비교가 필요한 경우 첨부해주세요.

## 렌더러 / 시각 회귀 메모

렌더링 경로를 바꿨다면 아래를 간단히 적어주세요.

- 영향받는 경로: legacy SVG / layer SVG / Canvas2D / CanvasKit / native Skia
- 남아 있는 known diff:
- 검증 명령:
