/**
 * DELETE transport fallback (customer egress silently drops HTTP DELETE, 2026-09-14 field incident).
 *
 * Zero DELETE reached the 222 server from the customer network since 09-14 while GET/POST/PATCH
 * arrived, so every delete (sheet, record, template, view ...) surfaced as "无法连接服务器（未收到任何
 * 响应）". The backend now accepts `POST` + `X-HTTP-Method-Override: DELETE` (core-backend
 * middleware/method-override.ts, mounted after auth) and exposes `DELETE /api/method-probe`.
 *
 * This module is the ONE place the web app decides how a DELETE travels:
 *   - `deleteTransport` is per browser session: 'native' (send DELETE) or 'override' (send POST +
 *     header). Kept in memory and mirrored to sessionStorage (guarded: private mode / disabled
 *     storage must not break deletes) so a reload inside the same tab does not re-learn it.
 *   - `probeDeleteTransport(baseFetch)` runs once after login: it sends the probe as a native DELETE
 *     and flips to 'override' ONLY when the call fails at the network level (no HTTP response:
 *     TypeError / AbortError / ≤ 8s timeout). Any HTTP status, including 4xx/5xx, means DELETE
 *     reaches the server and the mode stays 'native'.
 *   - `sendDelete(baseFetch, url, init)`: in 'override' mode sends POST + header from the start; in
 *     'native' mode sends DELETE and, on a network-level failure ONLY (never on any HTTP status),
 *     retries exactly once as POST + override and flips the mode when that retry gets a response.
 *     Deletes are idempotent so one retry is safe; a 4xx/5xx is an answer, not an outage, and is
 *     returned unchanged. If the retry gets no response either, nothing was learned (the link is
 *     down, not just DELETE) and the mode is left alone.
 *
 * `baseFetch` is injected so the caller keeps its own transport (utils/api.ts passes the raw
 * `fetch`; specs pass a mock). This module has no imports on purpose: utils/api.ts is a leaf loaded
 * by hundreds of specs.
 */

export type DeleteTransport = 'native' | 'override'

export type BaseFetch = (url: string, init: RequestInit) => Promise<Response>

export const DELETE_TRANSPORT_STORAGE_KEY = 'metasheet_delete_transport'
export const METHOD_OVERRIDE_HEADER = 'X-HTTP-Method-Override'
export const METHOD_PROBE_PATH = '/api/method-probe'
export const PROBE_TIMEOUT_MS = 8000

let transport: DeleteTransport | null = null
let probePromise: Promise<DeleteTransport> | null = null

function readStored(): DeleteTransport | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    const raw = sessionStorage.getItem(DELETE_TRANSPORT_STORAGE_KEY)
    return raw === 'override' || raw === 'native' ? raw : null
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

/**
 * Send a DELETE through whichever transport the session has learned. See the module header for
 * the retry rule: exactly one fallback attempt, only on a network-level failure, never on a status.
 */
export async function sendDelete(baseFetch: BaseFetch, url: string, init: RequestInit = {}): Promise<Response> {
  const nativeInit: RequestInit = { ...init, method: 'DELETE' }
  if (getDeleteTransport() === 'override') {
    return baseFetch(url, withOverride(nativeInit))
  }
  try {
    return await baseFetch(url, nativeInit)
  } catch (error) {
    // A caller-initiated abort is not an outage: do not buy a second attempt on their behalf.
    const signal = init.signal as AbortSignal | null | undefined
    if (signal?.aborted) throw error
    if (!isNetworkLevelFailure(error)) throw error
    const response = await baseFetch(url, withOverride(nativeInit))
    setDeleteTransport('override')
    return response
  }
}

/**
 * Learn the transport once per session by sending the probe as a native DELETE. Idempotent: a
 * second call while the first is in flight (or after it settled) returns the same promise/result.
 * Never throws: an unexpected failure leaves the mode as it was.
 */
export function probeDeleteTransport(baseFetch: BaseFetch, opts: { timeoutMs?: number; force?: boolean } = {}): Promise<DeleteTransport> {
  if (probePromise && !opts.force) return probePromise
  if (!opts.force && getDeleteTransport() === 'override') {
    probePromise = Promise.resolve('override')
    return probePromise
  }
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS
  probePromise = (async (): Promise<DeleteTransport> => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = setTimeout(() => controller?.abort(), timeoutMs)
    try {
      await baseFetch(METHOD_PROBE_PATH, { method: 'DELETE', signal: controller?.signal ?? undefined })
      // Any HTTP response — 200, 401, 404, 500 — proves DELETE reaches the server.
      setDeleteTransport('native')
      return 'native'
    } catch (error) {
      if (isNetworkLevelFailure(error)) {
        setDeleteTransport('override')
        return 'override'
      }
      return getDeleteTransport()
    } finally {
      clearTimeout(timer)
    }
  })()
  return probePromise
}
