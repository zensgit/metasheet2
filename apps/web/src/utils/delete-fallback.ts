/**
 * DELETE transport fallback (customer egress silently drops HTTP DELETE, 2026-09-14 field incident).
 *
 * Zero DELETE reached the 222 server from the customer network since 09-14 while GET/POST/PATCH
 * arrived, so every delete (sheet, record, template, view ...) surfaced as "无法连接服务器（未收到任何
 * 响应）". The backend accepts `POST` + `X-HTTP-Method-Override: DELETE` (core-backend
 * middleware/method-override.ts, mounted after auth AND after the attendance security guard), answers
 * the rewritten request with the receipt header `X-Method-Overridden: DELETE`, and exposes
 * `DELETE /api/method-probe`.
 *
 * THE RECEIPT IS NOT OPTIONAL — IT IS THE WHOLE SAFETY ARGUMENT. Sending a DELETE as a POST is only
 * safe if the server actually rewrote it. If a hop strips the override header, or the server predates
 * this middleware, the POST lands on whatever POST handler owns that path — and several paths have a
 * POST twin that does the OPPOSITE of the delete: `POST /api/comments/:id/reactions` ADDS the reaction
 * that `DELETE /api/comments/:id/reactions` removes, and answers 2xx. A silent inversion is worse than
 * a failed delete. So every response to an override-sent request must carry the receipt; a 2xx/3xx
 * without it is treated as a transport failure (`DeleteTransportError`), never as success.
 *
 * BE HONEST ABOUT WHAT THAT BUYS. If a hop strips the REQUEST header, the POST arrives as a plain
 * POST and the twin handler has already committed by the time any answer comes back — the receipt
 * check then refuses the 2xx and latches 'override-unavailable', so the user is told and it can
 * happen at most ONCE per session. Bounded and loud, not impossible. The other direction (the server
 * SEES the header but does not honour it, e.g. an auth-gate exception) is refused by the server with
 * 405 and never reaches a handler at all — core-backend middleware/method-override.ts.
 *
 * SESSION STATE (`deleteTransport`, in memory + sessionStorage under try/catch):
 *   - 'native'               — send DELETE. A network-level failure buys ONE retry as POST+override.
 *   - 'override'             — POST+override from the start; proven working by the probe or by a
 *                              receipt-carrying retry.
 *   - 'override-unavailable' — a POST+override was ANSWERED WITH SUCCESS (2xx/3xx) that carried no
 *                              receipt, i.e. something handled it without rewriting it. Behaves like
 *                              'native' for sending and additionally buys NO further POST retries
 *                              this session, so a stripped header can never be replayed into
 *                              repeated wrong writes. Only this one shape latches it: a >= 400 or a
 *                              dead link decides nothing (see the probe note below).
 *
 * `probeDeleteTransport(baseFetch)` runs once after login and exercises BOTH transports: native DELETE
 * first; only if that fails at the network level does it try `POST /api/method-probe` + override, and
 * it latches 'override' on EXACTLY the bit `sendDelete` latches on — `hasOverrideReceipt`.
 *
 * THE PROBE MAY ALSO NOT CONCLUDE MORE THAN `sendDelete` WOULD. An earlier draft latched
 * 'override-unavailable' on ANY receipt-less answer, so a 401/403/5xx produced ABOVE this middleware
 * (the session gate answers 403 `PASSWORD_CHANGE_REQUIRED` to a first login, 401 without a token; a
 * gateway answers 5xx) disabled the fallback for the whole session — and since 'override-unavailable'
 * also forbids the one-shot retry, every later delete then failed natively with no attempt at all.
 * The probe therefore DECIDES on only two things: a receipt (→ 'override') and a receipt-less
 * 2xx/3xx, which is the dangerous "something answered success to a POST nobody rewrote" shape
 * (→ 'override-unavailable', exactly what `sendDelete` concludes there). Everything else — any
 * >= 400, and no response at all on either leg — leaves the mode UNDECIDED, so the next real delete
 * still buys its single POST retry and can still learn the tunnel from a receipt.
 *
 * THE PROBE MAY NOT ACCEPT A WEAKER PROOF THAN `sendDelete` DEMANDS. `/api/method-probe` also reports
 * `overridden` in its BODY, and an earlier draft of this module let that body alone license the tunnel.
 * That is unsound: a hop that strips `X-Method-Overridden` from the response strips it from every
 * delete too, so the probe would promise a tunnel whose every use then failed the receipt gate — one
 * wasted delete per session, surfaced to the user as an error, for a mode we could have known was
 * unusable. One bit, one gate: the response header. The body field stays as server-side ops evidence
 * and is deliberately NOT read here.
 *
 * `baseFetch` is injected so the caller keeps its own transport (utils/api.ts passes the raw `fetch`;
 * specs pass a mock).
 */
/**
 * WHY THIS MODULE LIVES IN `src/utils/` AND NOT `src/api/` (2026-09-18, attendance-web-guard 6/6 red).
 * The Playwright verification harnesses intercept HTTP with `page.route('**\/api/**', ...)` and abort
 * anything they did not explicitly mock. In dev mode Vite serves source modules over HTTP, so a module
 * at `src/api/delete-fallback.ts` is fetched as `/src/api/delete-fallback.ts` — a URL that glob MATCHES.
 * `utils/api.ts` imports this module, so the abort killed the whole module graph and every harness
 * rendered an empty page (`apps/web/verification/attendance-makeup-request.spec.ts`, 6/6). Keep this
 * file (and anything `utils/api.ts` imports) OUT of any directory named `api`.
 */
import { isZhLocale } from './networkErrors'

export type DeleteTransport = 'native' | 'override' | 'override-unavailable'

export type BaseFetch = (url: string, init: RequestInit) => Promise<Response>

export const DELETE_TRANSPORT_STORAGE_KEY = 'metasheet_delete_transport'
export const METHOD_OVERRIDE_HEADER = 'X-HTTP-Method-Override'
export const METHOD_OVERRIDDEN_HEADER = 'X-Method-Overridden'
export const METHOD_PROBE_PATH = '/api/method-probe'
export const PROBE_TIMEOUT_MS = 8000

/** Machine-readable discriminator carried on the thrown error (`error.code`). */
export const DELETE_TRANSPORT_UNCONFIRMED = 'DELETE_TRANSPORT_UNCONFIRMED'

/**
 * Copy for "the server answered 2xx but never confirmed it treated this as a delete". It deliberately
 * does NOT say the delete failed (we cannot know) — it says the request was not handled as a delete
 * and asks for a refresh, which re-reads the truth from the server.
 */
export const DELETE_UNCONFIRMED_COPY = {
  en: 'The server did not process this request as a delete. Refresh the page and try again.',
  zh: '删除请求未被服务器按删除处理，请刷新后重试',
} as const

export interface DeleteTransportError extends Error {
  code: typeof DELETE_TRANSPORT_UNCONFIRMED
  /** 0 = "no trustworthy delete happened", distinguishing this from any 4xx/5xx status. */
  status: 0
  /** The status the server did answer with, for logs. */
  responseStatus: number
}

export function createDeleteTransportError(responseStatus: number): DeleteTransportError {
  const copy = isZhLocale() ? DELETE_UNCONFIRMED_COPY.zh : DELETE_UNCONFIRMED_COPY.en
  const error = new Error(copy) as DeleteTransportError
  error.name = 'DeleteTransportError'
  error.code = DELETE_TRANSPORT_UNCONFIRMED
  error.status = 0
  error.responseStatus = responseStatus
  return error
}

export function isDeleteTransportError(value: unknown): value is DeleteTransportError {
  return Boolean(value) && (value as { code?: unknown }).code === DELETE_TRANSPORT_UNCONFIRMED
}

let transport: DeleteTransport | null = null
let probePromise: Promise<DeleteTransport> | null = null

function isTransportValue(raw: unknown): raw is DeleteTransport {
  return raw === 'native' || raw === 'override' || raw === 'override-unavailable'
}

function readStored(): DeleteTransport | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    const raw = sessionStorage.getItem(DELETE_TRANSPORT_STORAGE_KEY)
    return isTransportValue(raw) ? raw : null
  } catch {
    return null
  }
}

function writeStored(mode: DeleteTransport): void {
  try {
    if (typeof sessionStorage === 'undefined') return
    sessionStorage.setItem(DELETE_TRANSPORT_STORAGE_KEY, mode)
  } catch {
    // Storage unavailable (private mode, quota, disabled): in-memory state still works.
  }
}

export function getDeleteTransport(): DeleteTransport {
  if (transport === null) transport = readStored() ?? 'native'
  return transport
}

export function setDeleteTransport(mode: DeleteTransport): void {
  transport = mode
  writeStored(mode)
}

/** Test hook: forget the in-memory state and the pending probe (storage is the spec's business). */
export function resetDeleteTransportForTests(): void {
  transport = null
  probePromise = null
}

/**
 * "No HTTP response at all": `fetch` rejected before a status line arrived. A TypeError is the
 * browser's transport failure ("Failed to fetch"); an AbortError here is our own probe timeout or
 * the caller's cancellation. HTTP responses never come through this path — they resolve.
 */
export function isNetworkLevelFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if (isDeleteTransportError(error)) return false
  if (error instanceof TypeError) return true
  const { name, code, status } = error as { name?: unknown; code?: unknown; status?: unknown }
  if (name === 'TypeError' || name === 'AbortError' || name === 'TimeoutError') return true
  // utils/networkErrors.ts's translated transport failure (status 0 = no response at all).
  return code === 'NETWORK_UNAVAILABLE' && status === 0
}

function withOverride(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers || undefined)
  headers.set(METHOD_OVERRIDE_HEADER, 'DELETE')
  return { ...init, method: 'POST', headers }
}

/** Did this response come back from a server that rewrote the POST into a DELETE? */
export function hasOverrideReceipt(response: Response): boolean {
  try {
    return response.headers?.get?.(METHOD_OVERRIDDEN_HEADER)?.toUpperCase() === 'DELETE'
  } catch {
    return false
  }
}

/**
 * Gate every override-sent response: a 2xx/3xx MUST carry the receipt. 4xx/5xx are refusals — no
 * wrong write can hide behind them — and are handed back unchanged so the caller's existing error
 * handling owns the copy.
 */
function confirmOverrideResponse(response: Response): Response {
  const status = response.status
  if (status >= 400) return response
  if (hasOverrideReceipt(response)) return response
  // The tunnel is not trustworthy on this path/hop: stop using it for the rest of the session.
  setDeleteTransport('override-unavailable')
  throw createDeleteTransportError(status)
}

/**
 * Send a DELETE through whichever transport the session has learned. See the module header for the
 * rules: exactly one fallback attempt, only on a network-level failure, never on an HTTP status, and
 * no override response is accepted as success without the receipt.
 */
export async function sendDelete(baseFetch: BaseFetch, url: string, init: RequestInit = {}): Promise<Response> {
  const nativeInit: RequestInit = { ...init, method: 'DELETE' }
  if (getDeleteTransport() === 'override') {
    return confirmOverrideResponse(await baseFetch(url, withOverride(nativeInit)))
  }
  try {
    return await baseFetch(url, nativeInit)
  } catch (error) {
    // A caller-initiated abort is not an outage: do not buy a second attempt on their behalf.
    const signal = init.signal as AbortSignal | null | undefined
    if (signal?.aborted) throw error
    if (!isNetworkLevelFailure(error)) throw error
    // 'override-unavailable' means the tunnel was already proven untrustworthy this session.
    if (getDeleteTransport() === 'override-unavailable') throw error
    const response = await baseFetch(url, withOverride(nativeInit))
    // ONLY a receipt-carrying answer licenses the tunnel for the rest of the session. A 4xx/5xx is a
    // refusal: nothing was wrongly written, so it is handed back unchanged and the mode stays
    // 'native' (a 404 from a server without the middleware must never license the tunnel).
    if (hasOverrideReceipt(response)) {
      setDeleteTransport('override')
      return response
    }
    if (response.status >= 400) return response
    setDeleteTransport('override-unavailable')
    throw createDeleteTransportError(response.status)
  }
}

/**
 * Learn the transport once per session, exercising BOTH paths. Idempotent: a second call while the
 * first is in flight (or after it settled) returns the same promise/result. Never throws.
 */
export function probeDeleteTransport(baseFetch: BaseFetch, opts: { timeoutMs?: number; force?: boolean } = {}): Promise<DeleteTransport> {
  if (probePromise && !opts.force) return probePromise
  if (!opts.force && getDeleteTransport() !== 'native') {
    probePromise = Promise.resolve(getDeleteTransport())
    return probePromise
  }
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS
  probePromise = (async (): Promise<DeleteTransport> => {
    const nativeOk = await (async () => {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = setTimeout(() => controller?.abort(), timeoutMs)
      try {
        await baseFetch(METHOD_PROBE_PATH, { method: 'DELETE', signal: controller?.signal ?? undefined })
        // Any HTTP response — 200, 401, 404, 500 — proves DELETE reaches the server.
        return true
      } catch (error) {
        // A non-transport rejection tells us nothing about the verb; leave the mode alone.
        if (!isNetworkLevelFailure(error)) return null
        return false
      } finally {
        clearTimeout(timer)
      }
    })()

    if (nativeOk === null) return getDeleteTransport()
    if (nativeOk) {
      setDeleteTransport('native')
      return 'native'
    }

    // Native DELETE never reached the server. Does the tunnel actually work HERE?
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = setTimeout(() => controller?.abort(), timeoutMs)
    try {
      const response = await baseFetch(METHOD_PROBE_PATH, withOverride({
        method: 'DELETE',
        signal: controller?.signal ?? undefined,
      }))
      // THE RECEIPT, AND ONLY THE RECEIPT — the same bit `sendDelete` latches on, so the probe can
      // never license a tunnel a real delete would then refuse. The status is irrelevant here: a
      // receipt-carrying 404 still proves this server rewrote the POST (the probe route could be
      // absent while the middleware is present); a 404 WITHOUT one is just express saying "no POST
      // handler here", which proves nothing.
      if (hasOverrideReceipt(response)) {
        setDeleteTransport('override')
        return 'override'
      }
      // NO RECEIPT. What may be CONCLUDED from that depends on what the answer proves, and the
      // standard is exactly the one `sendDelete` applies to its own retry:
      //   status >= 400 — a REFUSAL. Nothing was written, and the refusal may well have been
      //     produced ABOVE this middleware and say nothing about the tunnel: the global session gate
      //     answers 401 without a token and 403 `PASSWORD_CHANGE_REQUIRED` for a first login that
      //     must change its password (the probe path is not on that whitelist), and a proxy/gateway
      //     hiccup answers 5xx. Latching here would lock the WHOLE session out of the fallback on a
      //     pre-auth or transient answer — every later delete would then fail natively with no
      //     retry. So: decide nothing, leave the mode as it is, and let the next real delete's
      //     one-shot retry learn from a receipt. (`sendDelete` hands >= 400 back unchanged for the
      //     same reason.)
      //   status < 400 — a 2xx/3xx with no receipt is the DANGEROUS shape: something answered
      //     SUCCESS to a POST that was never rewritten (stripped header, old backend, or a POST twin
      //     doing the opposite of the delete). Sending real deletes through that could invert the
      //     user's intent, so the tunnel IS latched off for the session — the same conclusion
      //     `sendDelete` draws when its retry gets an unconfirmed 2xx.
      if (response.status >= 400) return getDeleteTransport()
      setDeleteTransport('override-unavailable')
      return 'override-unavailable'
    } catch {
      // The tunnel attempt got no response at all (transport failure, our 8s abort, or any other
      // rejection): it proved nothing about the override, so leave the mode alone rather than
      // burning the fallback for the session.
      return getDeleteTransport()
    } finally {
      clearTimeout(timer)
    }
  })()
  return probePromise
}
