// 뷰어 탭 관리
// - 뷰어 탭 열기/재활용
// - URL 파라미터로 파일 경로 전달

/**
 * 뷰어 탭을 열어 HWP 파일을 표시한다.
 * @param {object} [options]
 * @param {string} [options.url] - HWP 파일 URL
 * @param {string} [options.filename] - 표시용 파일명
 */
export function openViewer(options = {}) {
  const viewerBase = browser.runtime.getURL('viewer.html');
  const params = new URLSearchParams();

  if (options.url) params.set('url', options.url);
  if (options.filename) params.set('filename', options.filename);

  const query = params.toString();
  const fullUrl = query ? `${viewerBase}?${query}` : viewerBase;

  browser.tabs.create({ url: fullUrl }).catch((err) => {
    console.error('[rhwp] 뷰어 탭 생성 오류:', err);
  });
}

/**
 * 기존 빈 뷰어 탭이 있으면 재활용, 없으면 새 탭 생성.
 * @param {object} options
 */
export async function openViewerOrReuse(options = {}) {
  const viewerBase = browser.runtime.getURL('viewer.html');

  // 빈 뷰어 탭 검색
  const tabs = await browser.tabs.query({ url: `${viewerBase}*` });
  const emptyTab = tabs.find(t => t.url === viewerBase);

  if (emptyTab) {
    // 기존 빈 탭에 파일 로드
    const params = new URLSearchParams();
    if (options.url) params.set('url', options.url);
    if (options.filename) params.set('filename', options.filename);

    await browser.tabs.update(emptyTab.id, {
      url: `${viewerBase}?${params.toString()}`,
      active: true
    });
  } else {
    openViewer(options);
  }
}
