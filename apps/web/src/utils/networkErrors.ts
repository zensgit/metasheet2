/**
 * Transport-layer failure copy and error shape.
 *
 * WHY THIS EXISTS. When the backend is down (measured window: an in-place upgrade
 * takes the pm2 app offline for ~2.5 minutes — see
 * docs/development/takeover-beiliao-20260821/222-deploy-window-runbook-20260901.md),
 * `fetch()` rejects with a browser-authored `TypeError` whose message is a raw
 * engine literal: "Failed to fetch" (Chromium), "NetworkError when attempting to
 * fetch resource." (Firefox), "Load failed" (WebKit). Every multitable write path
 * uses `e.message` VERBATIM as user-facing copy
 * (multitable/composables/useMultitableGrid.ts `error.value = e.message ?? fallback(...)`
 * -> multitable/views/MultitableWorkbench.vue `showError(grid.error.value)` ->
 * multitable/components/MetaToast.vue), so that engine literal reached testers as a
 * red toast. Translating at the single `fetch` call site in `utils/api.ts` repairs
 * EVERY existing catch site with zero call-site edits.
 *
 * WORDING IS DELIBERATELY NEUTRAL. The copy must NOT say "upgrading"/"升级": that
 * would tell a customer we touched their machine during their working hours. This
 * is an owner ruling, not a style preference — do not "improve" it into a
 * maintenance announcement.
 *
 * WHY LOCALE IS READ FROM STORAGE AND NOT FROM `useLocale()`. `utils/api.ts` is a
 * leaf imported by hundreds of specs, 10+ of which `vi.mock` the `useLocale`
 * composable with partial stubs; importing it here would make this module's import
 * depend on every one of those stubs (the same failure mode documented at the top of
 * composables/authPrincipal.ts). `useLocale.setLocale()` PERSISTS to this exact key,
 * so reading the key live is equivalent to — and never staler than — the composable.
 */

/** Machine-readable discriminator carried on the thrown error (`error.code`). */
export const NETWORK_UNAVAILABLE = 'NETWORK_UNAVAILABLE'

/** Same key `composables/useLocale.ts` reads and persists. */
const LOCALE_STORAGE_KEY = 'metasheet_locale'

const NETWORK_UNAVAILABLE_COPY = {
  en: 'The service is temporarily unavailable. Please try again in a moment.',
  zh: '服务暂时不可用，请稍后重试',
} as const

export interface NetworkUnavailableError extends Error {
  code: typeof NETWORK_UNAVAILABLE
  /** 0 = "no HTTP response at all", distinguishing this from any 4xx/5xx status. */
  status: 0
  cause?: unknown
}

/** Human copy for a transport failure. Neutral by contract — see file header. */
export function networkUnavailableMessage(isZh: boolean): string {
  return isZh ? NETWORK_UNAVAILABLE_COPY.zh : NETWORK_UNAVAILABLE_COPY.en
}

/** Mirrors `useLocale.normalizeLocale` for the zh decision only. */
export function isZhLocale(): boolean {
  if (typeof window === 'undefined') return false
  let stored: string | null = null
  try {
    stored = typeof window.localStorage?.getItem === 'function'
      ? window.localStorage.getItem(LOCALE_STORAGE_KEY)
      : null
  } catch {
    stored = null
  }
  const raw = stored || (typeof navigator !== 'undefined' ? navigator.language : '') || ''
  const normalized = String(raw).trim().toLowerCase()
  return normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-hans'
}

/**
 * Build the error that replaces the browser's transport literal. Keeps the original
 * rejection on `cause` so console/telemetry can still see "Failed to fetch".
 */
export function createNetworkUnavailableError(cause: unknown): NetworkUnavailableError {
  const error = new Error(networkUnavailableMessage(isZhLocale())) as NetworkUnavailableError
  error.name = 'NetworkUnavailableError'
  error.code = NETWORK_UNAVAILABLE
  error.status = 0
  error.cause = cause
  return error
}

/** True for errors produced by `createNetworkUnavailableError`. */
export function isNetworkUnavailableError(value: unknown): value is NetworkUnavailableError {
  return Boolean(value) && (value as { code?: unknown }).code === NETWORK_UNAVAILABLE
}
