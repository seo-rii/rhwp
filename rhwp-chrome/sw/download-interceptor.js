// 다운로드 가로채기 (Chrome)
// - .hwp/.hwpx 다운로드 감지 → 뷰어로 열기
// - 사용자 설정(autoOpen)에 따라 동작
//
// #198 (chrome-fd-001): HWP 가 아닌 일반 파일 다운로드에는 suggest() 를 호출하지 않아
//                       Chrome 의 마지막 저장 위치 기억 동작을 보존한다.
// #207: 판정 로직은 rhwp-shared/sw/download-interceptor-common.js 와 공유.

import { openViewer } from './viewer-launcher.js';
import { shouldInterceptDownload } from './download-interceptor-common.js';

/**
 * 다운로드 인터셉터를 설정한다.
 *
 * - HWP/HWPX 다운로드: handleHwpDownload + suggest 호출 (자체 뷰어 트리거)
 * - 일반 파일: suggest 호출 안 함 → Chrome 의 마지막 저장 위치 기억 동작 유지 (#198)
 */
export function setupDownloadInterceptor() {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (shouldInterceptDownload(item)) {
      handleHwpDownload(item);
      suggest({ filename: item.filename });
    }
    // HWP 가 아니면 suggest 호출하지 않는다 — Chrome 기본 동작 유지 (#198)
  });
}

async function handleHwpDownload(item) {
  try {
    const settings = await chrome.storage.sync.get({ autoOpen: true });
    if (!settings.autoOpen) return;

    // 대용량 파일 경고 (50MB 초과)
    if (item.fileSize > 50 * 1024 * 1024) {
      console.warn(`[rhwp] 대용량 파일: ${item.filename} (${(item.fileSize / 1024 / 1024).toFixed(1)}MB)`);
    }

    openViewer({
      url: item.url,
      filename: item.filename,
    });
  } catch (err) {
    console.error('[rhwp] 다운로드 인터셉터 오류:', err);
  }
}
