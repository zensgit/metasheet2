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
 * TWO OUTCOMES, TWO SENTENCES (P5, 2026-09-14 field incident). The customer link to
 * the 222 host went down for a stretch; every action showed the gateway wording
 * ("the service is temporarily unavailable"), so the customer concluded the DELETE
 * feature was broken rather than that their network was cut. The discrimination is
 * exactly "did we receive an HTTP response at all":
 *   - NO response (fetch rejected: TypeError / net::ERR_*) -> NETWORK_UNREACHABLE_COPY,
 *     which names the missing response and points at the network.
 *   - A response exists (5xx, a 503 maintenance-page JSON, even a 200 that is not
 *     JSON) -> SERVICE_UNAVAILABLE_COPY, i.e. today's wording, unchanged.
 * `unavailableMessageFor` is the SINGLE place that decision is made, and both
 * producing sites CALL it: utils/api.ts (`createNetworkUnavailableError`, transport
 * rewrite) and multitable/utils/meta-api-error-labels.ts (`apiDefaultErrorMessage`,
 * gateway 502/503/504). SCOPE, stated exactly because an earlier draft of this
 * paragraph overclaimed: "both producing sites" means the two sites that produce THIS
 * pair of outage sentences. It is NOT a claim about every connectivity string in the
 * app -- views/GalleryView.vue and views/KanbanView.vue still set their own legacy
 * '无法连接到服务器' out of a blanket `catch` that also swallows real 5xx RESPONSES.
 * That copy is older than this module, is not routed through it, and is deliberately
 * left alone here; it is a separate cleanup, and it is the reason this header does not
 * say "and nowhere else".
 *
 * WORDING IS DELIBERATELY NEUTRAL. Neither copy may say "upgrading"/"升级": that
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

/**
 * A RESPONSE EXISTS but the service cannot serve the request (gateway 502/503/504, a
 * maintenance-page JSON body). Unchanged wording -- the field incident did not
 * question this sentence, only its use for the no-response case.
 */
export const SERVICE_UNAVAILABLE_COPY = {
  en: 'The service is temporarily unavailable. Please try again in a moment.',
  zh: '服务暂时不可用，请稍后重试',
} as const

/**
 * NO RESPONSE AT ALL: `fetch` rejected before any status line arrived. The sentence
 * says so explicitly and sends the reader to the network, because that is the only
 * thing they can act on. Do not merge it back into SERVICE_UNAVAILABLE_COPY.
 */
export const NETWORK_UNREACHABLE_COPY = {
  en: 'Cannot reach the server (no response received). Check your network connection, or try again later.',
  zh: '无法连接服务器（未收到任何响应），请检查网络或稍后重试',
} as const

export interface NetworkUnavailableError extends Error {
  code: typeof NETWORK_UNAVAILABLE
  /** 0 = "no HTTP response at all", distinguishing this from any 4xx/5xx status. */
  status: 0
  cause?: unknown
}

/**
 * Does this failure carry an HTTP response? A `Response` (real or a spec double with
 * `status`+`ok`), an error that hangs one off `.response`, or an error that already
 * carries a non-zero HTTP `status` all mean "the server answered". Everything else --
 * a `TypeError` from a rejected `fetch`, a `net::ERR_*`, `undefined` -- means nothing
 * came back. `status: 0` is deliberately NOT a response: that is the marker
 * `createNetworkUnavailableError` itself stamps on the no-response error.
 */
export function hasHttpResponse(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  if (typeof Response !== 'undefined' && input instanceof Response) return true
  if (isResponseShaped(input)) return true
  const carrier = input as { status?: unknown; response?: unknown }
  if (isResponseShaped(carrier.response)) return true
  return typeof carrier.status === 'number' && Number.isFinite(carrier.status) && carrier.status > 0
}

function isResponseShaped(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const shape = value as { status?: unknown; ok?: unknown }
  return typeof shape.status === 'number' && typeof shape.ok === 'boolean'
}

/**
 * THE mapping helper. Give it whatever the failure site is holding -- the rejected
 * value, or the `Response` it just read -- and it returns the one sentence the user
 * should see. This is the only place the two copies are chosen between.
 */
export function unavailableMessageFor(input: unknown, isZh: boolean): string {
  const copy = hasHttpResponse(input) ? SERVICE_UNAVAILABLE_COPY : NETWORK_UNREACHABLE_COPY
  return isZh ? copy.zh : copy.en
}

/**
 * Copy for "fetch came back with nothing". Thin alias kept because call sites and
 * specs already import it; it must stay a pass-through to the helper above.
 */
export function networkUnavailableMessage(isZh: boolean): string {
  return unavailableMessageFor(undefined, isZh)
}

/** Copy for "the server answered, but cannot serve this right now". */
export function serviceUnavailableMessage(isZh: boolean): string {
  return isZh ? SERVICE_UNAVAILABLE_COPY.zh : SERVICE_UNAVAILABLE_COPY.en
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
  const error = new Error(unavailableMessageFor(cause, isZhLocale())) as NetworkUnavailableError
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
