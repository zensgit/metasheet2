/**
 * SSRF-safe egress for webhook sends (button action B1-S2 #2897 §3.1; rule-driven `send_webhook` and
 * subscription delivery since S0-a). The SSRF guard (`checkWebhookTargetUrl`) validates the URL and returns
 * the resolved addresses; this helper then connects to ONE of those PINNED addresses instead of
 * re-resolving the hostname — closing the DNS-rebinding window between the check and the request. A plain
 * `fetch(url)` would re-resolve and defeat the guard ("resolve-then-pin only works if you connect to the pin").
 *
 * The original hostname is preserved: TLS SNI keeps the URL's hostname and the `Host` header is forced
 * to the URL host (a caller-supplied Host is stripped — no virtual-host confusion); only DNS resolution
 * is overridden via the `lookup` option. Certificate verification is NOT relaxed by the pin. No retry
 * (at-most-once). Redirects are never followed: `https.request` does not follow, so a 3xx comes back as a
 * plain status and no second request is made. By default returns the status only — resolved on the response
 * HEADERS, then the socket is destroyed, so a slow/endless body can never stall the action and the body is
 * never read/persisted/logged. A caller that records the receiver's answer opts into a BOUNDED body read
 * (`responseBodyLimit`), still under the same deadline.
 */
import https from 'node:https'
import type { IncomingMessage } from 'node:http'

export type PinnedFetchResult = {
  status: number
  ok: boolean
  /** Only when `responseBodyLimit` was set and the status is not 3xx: the first bytes of the body, as UTF-8. */
  body?: string
}

/**
 * Fixed `User-Agent` for every pinned webhook send, named like the other outbound senders
 * (`MetaSheet-Automation-DingTalk/1.0`, `MetaSheet-Notification-Service/1.0`). A caller-supplied one wins.
 */
export const PINNED_WEBHOOK_USER_AGENT = 'MetaSheet-Automation-Webhook/1.0'

export type HttpsRequestFn = typeof https.request

export interface PinnedFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Socket-idle timeout AND an overall deadline for reaching the response headers. */
  timeoutMs: number
  /**
   * Extra trust anchor (PEM). Production callers never pass it — the system trust store applies. Loopback
   * tests use it to trust a certificate generated at runtime without disabling verification.
   */
  ca?: string
  /**
   * Read at most this many bytes of a non-3xx response body (subscription delivery records the receiver's
   * answer). OMITTED ⇒ the body is never read — the socket is destroyed on the headers. The read is bounded
   * by the same deadline; when the deadline fires after the headers, the status and the bytes read so far
   * are returned (the request was delivered). A 3xx body is never read.
   */
  responseBodyLimit?: number
}

/** The signature callers depend on, so a test can wrap the real helper without re-declaring it. */
export type PinnedSendFn = (
  url: string,
  pinnedAddress: string,
  family: 4 | 6,
  opts: PinnedFetchOptions,
) => Promise<PinnedFetchResult>

/** Address family of a pinned IP literal. */
export function pinnedAddressFamily(address: string): 4 | 6 {
  return address.includes(':') ? 6 : 4
}

function timeoutError(): Error {
  // `name = 'TimeoutError'` is what the shared classifiers read (`classifyFetchError`,
  // `classifyWebhookFailure`) — the same label a fetch AbortSignal timeout gets.
  const err = new Error('webhook request timed out')
  err.name = 'TimeoutError'
  return err
}

export async function pinnedHttpsFetch(
  url: string,
  pinnedAddress: string,
  family: 4 | 6,
  opts: PinnedFetchOptions,
  requestImpl: HttpsRequestFn = https.request,
): Promise<PinnedFetchResult> {
  // Refuse what the platform `fetch` refuses, BEFORE any socket. `https.request` would turn URL userinfo
  // into an `Authorization: Basic` header; `fetch` throws at Request construction instead. Same TypeError
  // class (so the failure classifiers label it `invalid-request`), but the message never quotes the URL.
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new TypeError('webhook URL is malformed')
  }
  if (parsed.protocol !== 'https:') throw new TypeError('webhook URL must use https')
  if (parsed.username || parsed.password) throw new TypeError('webhook URL must not include credentials')

  return await new Promise<PinnedFetchResult>((resolve, reject) => {
    let settled = false
    const timers: { deadline?: ReturnType<typeof setTimeout>; onDeadline?: () => void } = {}
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timers.deadline) clearTimeout(timers.deadline)
      fn()
    }
    // Force the Host header to the URL's host. A caller-supplied Host would split the HTTP identity from
    // the pinned connection + TLS SNI (virtual-host confusion), so strip any caller host/Host and set it
    // from the URL — Host stays aligned with what was validated and connected to.
    //
    // WIRE FRAMING (S0-a review F1). Without an explicit length `https.request` frames a written body as
    // `Transfer-Encoding: chunked`, which some receivers (API gateways, WAF profiles) reject — the platform
    // `fetch` sent a `Content-Length` for the same string body. So the length is computed HERE from the bytes
    // actually written (UTF-8), and any caller-supplied `Content-Length` / `Transfer-Encoding` is dropped so a
    // stale or conflicting value can never frame the request. Every other caller header is kept as given.
    // A fixed `User-Agent` is set unless the caller supplied one (the platform `fetch` sent `node`).
    // `Connection: close` is intentional (see `agent: false` below): one request per connection.
    const bodyBuffer = typeof opts.body === 'string' && opts.body.length > 0 ? Buffer.from(opts.body, 'utf8') : null
    const safeHeaders: Record<string, string> = {}
    let callerUserAgent = false
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      const lower = k.toLowerCase()
      if (lower === 'host' || lower === 'content-length' || lower === 'transfer-encoding') continue
      if (lower === 'user-agent') callerUserAgent = true
      safeHeaders[k] = v
    }
    safeHeaders.host = parsed.host
    safeHeaders['content-length'] = String(bodyBuffer ? bodyBuffer.length : 0)
    if (!callerUserAgent) safeHeaders['user-agent'] = PINNED_WEBHOOK_USER_AGENT
    const req = requestImpl(
      url,
      {
        method: opts.method ?? 'POST',
        headers: safeHeaders,
        timeout: opts.timeoutMs,
        // One agent per request, never pooled: a kept-alive socket is keyed by host/port, not by the pin,
        // so a pooled socket opened for an earlier pin could otherwise carry a later request.
        agent: false,
        // THE pin: bypass DNS and connect to the pre-validated address. SNI keeps the URL's hostname
        // (https.request default) and the Host header is forced to it above, so the connection targets
        // the checked IP while the TLS/HTTP identity stays the original host — the rebinding window is closed.
        //
        // BOTH answer shapes. Node 20+ (`autoSelectFamily` on by default) calls a custom lookup with
        // `{ all: true }` and REJECTS a single-string answer (ERR_INVALID_IP_ADDRESS) before connecting; the
        // legacy shape is a string + family. Either way the only address offered is the pin.
        lookup: (_hostname: string, options: unknown, cb: (...args: unknown[]) => void) => {
          if (options && typeof options === 'object' && (options as { all?: unknown }).all) {
            cb(null, [{ address: pinnedAddress, family }])
          } else {
            cb(null, pinnedAddress, family)
          }
        },
        ...(opts.ca ? { ca: opts.ca } : {}),
      } as https.RequestOptions,
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0
        const ok = status >= 200 && status < 300
        const limit = opts.responseBodyLimit
        if (!limit || limit <= 0 || (status >= 300 && status < 400)) {
          // Resolve on HEADERS — the status is known here. Do NOT await the body: a malicious target could
          // stream an endless/slow body to keep the action open and dodge an inactivity timeout. Destroy the
          // socket to discard the (never-read) body immediately.
          finish(() => resolve({ status, ok }))
          res.destroy()
          return
        }
        // Bounded read: at most `limit` bytes, and never past the deadline (see `timers.onDeadline`).
        const chunks: Buffer[] = []
        let size = 0
        const done = () => finish(() => resolve({ status, ok, body: Buffer.concat(chunks).toString('utf8') }))
        timers.onDeadline = () => {
          done()
          res.destroy()
        }
        res.on('data', (chunk: Buffer | string) => {
          if (size >= limit) return
          const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
          const take = buf.subarray(0, limit - size)
          chunks.push(take)
          size += take.length
          if (size >= limit) {
            done()
            res.destroy()
          }
        })
        res.on('end', done)
        res.on('close', done)
        // A body error after the headers keeps the status: the request itself was delivered.
        res.on('error', done)
      },
    )
    // `timeout` above is an IDLE timeout; a target trickling bytes could keep it from ever firing. The
    // deadline bounds the whole wait for headers.
    timers.deadline = setTimeout(() => {
      if (timers.onDeadline) {
        // Headers already arrived: keep the status and the bytes read so far.
        timers.onDeadline()
        return
      }
      req.destroy(timeoutError())
      finish(() => reject(timeoutError()))
    }, opts.timeoutMs)
    req.on('error', (e: Error) => finish(() => reject(e)))
    req.on('timeout', () => {
      if (timers.onDeadline) {
        timers.onDeadline()
        return
      }
      req.destroy(timeoutError())
      finish(() => reject(timeoutError()))
    })
    // Exactly the bytes `content-length` announced.
    if (bodyBuffer) req.write(bodyBuffer)
    req.end()
  })
}
