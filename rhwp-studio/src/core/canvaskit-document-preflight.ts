import type { CanvasKitDocumentPreflight } from './types';

const PREFLIGHT_STATUSES = new Set(['eligible', 'ineligible', 'incomplete']);
const PREFLIGHT_MODES = new Set(['default', 'compat']);
const RENDER_PROFILES = new Set(['fast-preview', 'screen', 'print', 'high-quality']);

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isBoundedStringArray(value: unknown, maxLength: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maxLength
    && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 256);
}

export function parseCanvasKitDocumentPreflight(
  json: string,
  source = 'CanvasKit document preflight',
): CanvasKitDocumentPreflight {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`${source} parse 실패: ${error}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${source} shape 오류: object가 아닙니다`);
  }

  const report = parsed as Partial<CanvasKitDocumentPreflight>;
  const summary = report.summary as Record<string, unknown> | undefined;
  const limits = report.limits as Record<string, unknown> | undefined;
  if (
    report.schemaVersion !== 1
    || !PREFLIGHT_MODES.has(String(report.mode))
    || !RENDER_PROFILES.has(String(report.profile))
    || !PREFLIGHT_STATUSES.has(String(report.status))
    || typeof report.eligible !== 'boolean'
    || typeof report.complete !== 'boolean'
    || !isFiniteNonNegativeNumber(report.pageCount)
    || !isFiniteNonNegativeNumber(report.scannedPages)
    || !isFiniteNonNegativeNumber(report.scannedWorkUnits)
    || !Array.isArray(report.blockers)
    || !summary
    || !limits
    || typeof report.capabilityDigest !== 'string'
    || ![
      'totalItems',
      'directItems',
      'directRequiredItems',
      'compatOverlayItems',
      'textFallbackItems',
      'unsupportedItems',
      'hiddenOverlayViolations',
    ].every(key => isFiniteNonNegativeNumber(summary[key]))
    || !['maxPages', 'maxWorkUnits', 'maxBlockers', 'maxRequiredFontFamilies'].every(
      key => isFiniteNonNegativeNumber(limits[key]),
    )
    || !isBoundedStringArray(
      report.requiredFontFamilies,
      Number(limits.maxRequiredFontFamilies),
    )
  ) {
    throw new Error(`${source} shape 오류: 필수 필드가 없습니다`);
  }
  return report as CanvasKitDocumentPreflight;
}

function surfaceCapabilitySuffix(details: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const char of details.join('\u0000')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Surface-specific requirements are folded into the bounded WASM report before auto selection. */
export function withCanvasKitSurfaceBlockers(
  report: CanvasKitDocumentPreflight,
  blockerDetails: readonly string[],
): CanvasKitDocumentPreflight {
  const details = [...new Set(blockerDetails.map(detail => detail.trim()).filter(Boolean))]
    .sort()
    .map(detail => detail.slice(0, 256));
  if (details.length === 0) return report;

  const remainingBlockers = Math.max(0, report.limits.maxBlockers - report.blockers.length);
  const blockers = [
    ...report.blockers.map(blocker => ({ ...blocker })),
    ...details.slice(0, remainingBlockers).map(detail => ({
      code: 'unsupported' as const,
      pageIndex: 0,
      opType: 'textRun',
      detail,
    })),
  ];
  return {
    ...report,
    status: report.complete ? 'ineligible' : 'incomplete',
    eligible: false,
    limits: { ...report.limits },
    summary: {
      ...report.summary,
      totalItems: report.summary.totalItems + details.length,
      unsupportedItems: report.summary.unsupportedItems + details.length,
    },
    blockers,
    requiredFontFamilies: [...report.requiredFontFamilies],
    capabilityDigest: `${report.capabilityDigest}:surface-${surfaceCapabilitySuffix(details)}`,
  };
}
