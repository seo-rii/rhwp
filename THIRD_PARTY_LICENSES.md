# Third-Party Licenses

rhwp 프로젝트가 사용하는 서드파티 라이브러리 및 리소스의 라이선스 목록이다.

---

## Rust 크레이트 (직접 의존성)

| 크레이트 | 버전 | 라이선스 | 저장소 |
|---------|------|---------|--------|
| base64 | 0.22.1 | MIT OR Apache-2.0 | marshallpierce/rust-base64 |
| byteorder | 1.5.0 | Unlicense OR MIT | BurntSushi/byteorder |
| cfb | 0.13.0 | MIT | mdsteele/rust-cfb |
| codepage | 0.1.2 | Apache-2.0 OR MIT | hsivonen/codepage |
| console_error_panic_hook | 0.1.7 | Apache-2.0 OR MIT | rustwasm/console_error_panic_hook |
| embedded-io | 0.7.1 | MIT OR Apache-2.0 | rust-embedded/embedded-hal |
| encoding_rs | 0.8.35 | (Apache-2.0 OR MIT) AND BSD-3-Clause | hsivonen/encoding_rs |
| flate2 | 1.1.9 | MIT OR Apache-2.0 | rust-lang/flate2-rs |
| js-sys | 0.3.92 | MIT OR Apache-2.0 | rustwasm/wasm-bindgen |
| paste | 1.0.15 | MIT OR Apache-2.0 | dtolnay/paste |
| pdf-writer | 0.12.1 | MIT OR Apache-2.0 | typst/pdf-writer |
| quick-xml | 0.37.5 | MIT | tafia/quick-xml |
| snafu | 0.8.9 | MIT OR Apache-2.0 | shepmaster/snafu |
| strum | 0.27.2 | MIT | Peternator7/strum |
| svg2pdf | 0.13.0 | MIT OR Apache-2.0 | typst/svg2pdf |
| unicode-segmentation | 1.13.2 | MIT OR Apache-2.0 | unicode-rs/unicode-segmentation |
| unicode-width | 0.2.2 | MIT OR Apache-2.0 | unicode-rs/unicode-width |
| usvg | 0.45.1 | Apache-2.0 OR MIT | linebender/resvg |
| wasm-bindgen | 0.2.115 | MIT OR Apache-2.0 | rustwasm/wasm-bindgen |
| wasm-bindgen-test | 0.3.65 | MIT OR Apache-2.0 | rustwasm/wasm-bindgen |
| web-sys | 0.3.92 | MIT OR Apache-2.0 | rustwasm/wasm-bindgen |
| zip | 2.4.2 | MIT | zip-rs/zip2 |

간접 의존성(transitive) 144개 크레이트 포함. 전체 목록은 `cargo metadata`로 확인 가능.

### 라이선스 요약 (전체 의존성)

| 라이선스 | 크레이트 수 |
|---------|-----------|
| MIT OR Apache-2.0 | 78 |
| MIT | 22 |
| Apache-2.0 OR MIT | 13 |
| MIT/Apache-2.0 | 8 |
| MIT OR Apache-2.0 OR Zlib | 5 |
| Unlicense OR MIT | 4 |
| Zlib OR Apache-2.0 OR MIT | 3 |
| BSD-3-Clause | 2 |
| BSD-3-Clause OR Apache-2.0 | 2 |
| Unlicense/MIT | 2 |
| 기타 (0BSD, BSD-2-Clause, Zlib 등) | 5 |

> 모든 Rust 의존성은 MIT, Apache-2.0, BSD, Zlib, Unlicense 등 OSI 승인 라이선스이며,
> rhwp의 MIT 라이선스와 호환된다.

---

## npm 패키지

### rhwp-studio

| 패키지 | 버전 | 라이선스 | 용도 |
|--------|------|---------|------|
| puppeteer-core | ^24.38.0 | Apache-2.0 | E2E 테스트 (CDP 연결) |
| typescript | ^5.7.0 | Apache-2.0 | TypeScript 컴파일 |
| vite | ^6.1.0 | MIT | 개발 서버 + 빌드 |

### rhwp-vscode

| 패키지 | 버전 | 라이선스 | 용도 |
|--------|------|---------|------|
| @types/node | ^20.0.0 | MIT | TypeScript 타입 정의 |
| @types/vscode | ^1.82.0 | MIT | VSCode API 타입 정의 |
| copy-webpack-plugin | ^14.0.0 | MIT | Webpack 파일 복사 |
| null-loader | ^4.0.1 | MIT | Webpack 로더 |
| ts-loader | ^9.5.0 | MIT | Webpack TypeScript 로더 |
| typescript | ^5.7.0 | Apache-2.0 | TypeScript 컴파일 |
| webpack | ^5.98.0 | MIT | 번들러 |
| webpack-cli | ^6.0.0 | MIT | Webpack CLI |

---

## 웹 폰트 (오픈 라이선스)

`web/fonts/`에 포함된 폰트. 저작권 폰트는 제외되었으며 별도 목록은 `web/fonts/FONTS.md` 참조.

| 폰트 | 라이선스 | 출처 |
|------|---------|------|
| Pretendard (9종) | SIL Open Font License 1.1 | github.com/orioncactus/pretendard |
| Cafe24 써라운드 | 카페24 무료 배포 | fonts.cafe24.com |
| Cafe24 슈퍼매직 | 카페24 무료 배포 | fonts.cafe24.com |
| 행복고딕 (Happiness Sans, 4종) | 무료 배포 | 행복나눔재단 |
| 스포카 한 산스 | SIL Open Font License 1.1 | github.com/spoqa/spoqa-han-sans |

---

## 도구

| 도구 | 라이선스 | 용도 |
|------|---------|------|
| Docker | Apache-2.0 | WASM 빌드 환경 |
| wasm-pack | MIT OR Apache-2.0 | WASM 패키징 |
| Chrome DevTools Protocol | BSD-3-Clause | E2E 테스트 |

---

## 참조한 오픈소스 프로젝트 (스펙·설계 참조)

rhwp는 아래 프로젝트들의 **코드를 직접 복사하지 않으며**, 공개된 스펙 정보(enum 값·속성 기본값·태그 이름·검증 규칙 등)만 참조한다. Apache 2.0 라이선스 고지 의무는 본 문서와 각 참조 파일의 헤더 주석으로 충족한다.

| 프로젝트 | 라이선스 | 참조 범위 | rhwp 위치 |
|---------|---------|----------|-----------|
| [hancom-io/hwpx-owpml-model](https://github.com/hancom-io/hwpx-owpml-model) | Apache-2.0 © 2022 Hancom Inc. | HWPX enum 정의, 속성 기본값, 태그 전체 집합, canonical 속성·자식 순서 | `src/serializer/hwpx/canonical_defaults.rs` (예정), `mydocs/tech/hwpx_hancom_reference.md` |
| [hancom-io/dvc](https://github.com/hancom-io/dvc) | Apache-2.0 © 2022 Hancom Inc. | HWPX 검증 규칙 JSON 스키마, errorCode 체계 (Rust 포팅 예정 #185) | `mydocs/tech/hwpx_dvc_reference.md` |

---

## 라이선스 호환성

rhwp는 **MIT 라이선스**로 배포된다.

- MIT, Apache-2.0, BSD, Zlib, Unlicense — 모두 MIT와 호환
- `encoding_rs`의 BSD-3-Clause 조항은 고지 의무만 요구하며, 이 문서로 충족
- 저작권이 있는 폰트(한컴, Microsoft)는 Git에서 완전 제거되었으며 `ttfs/FONTS.md`, `web/fonts/FONTS.md`에 목록만 관리

---

*이 문서는 `cargo metadata` 및 `package.json` 기반으로 생성되었으며, 의존성 업데이트 시 함께 갱신해야 한다.*
