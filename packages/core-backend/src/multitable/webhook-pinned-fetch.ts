/**
 * SSRF-safe egress for the send_webhook button action (B1-S2, #2897 §3.1). The SSRF guard
 * (`checkWebhookTargetUrl`) validates the URL and returns the resolved addresses; this helper then
 * connects to ONE of those PINNED addresses instead of re-resolving the hostname — closing the
 * DNS-rebinding window between the check and the request. A plain `fetch(url)` would re-resolve and
 * defeat the guard ("resolve-then-pin only works if you connect to the pin").
 *
 * The original hostname is preserved: TLS SNI keeps the URL's hostname and the `Host` header is forced
 * to the URL host (a caller-supplied Host is stripped — no virtual-host confusion); only DNS resolution
 * is overridden via the `lookup` option. No retry (at-most-once). Returns the status only — resolved on
 * the response HEADERS, then the socket is destroyed, so a slow/endless body can never stall the action
 * and the body is never read/persisted/logged.
 */
import https from 'node:https'
import type { IncomingMessage } from 'node:http'

export type PinnedFetchResult = { status: number; ok: boolean }

export type HttpsRequestFn = typeof https.request

export interface PinnedFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs: number
}

export async function pinnedHttpsFetch(
  url: string,
  pinnedAddress: string,
  family: 4 | 6,
  opts: PinnedFetchOptions,
  requestImpl: HttpsRequestFn = https.request,
): Promise<PinnedFetchResult> {
  return await new Promise<PinnedFetchResult>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    // Force the Host header to the URL's host. A caller-supplied Host would split the HTTP identity from
    // the pinned connection + TLS SNI (virtual-host confusion), so strip any caller host/Host and set it
    // from the URL — Host stays aligned with what was validated and connected to.
    const safeHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      if (k.toLowerCase() === 'host') continue
      safeHeaders[k] = v
    }
    safeHeaders.host = new URL(url).host
    const req = requestImpl(
      url,
      {
        method: opts.method ?? 'POST',
        headers: safeHeaders,
        timeout: opts.timeoutMs,
        // THE pin: bypass DNS and connect to the pre-validated address. SNI keeps the URL's hostname
        // (https.request default) and the Host header is forced to it above, so the connection targets
        // the checked IP while the TLS/HTTP identity stays the original host — the rebinding window is closed.
        lookup: (_hostname: string, _options: unknown, cb: (err: Error | null, address: string, family: number) => void) => {
          cb(null, pinnedAddress, family)
        },
      } as https.RequestOptions,
      (res: IncomingMessage) => {
        // Resolve on HEADERS — the status is known here. Do NOT await the body: a malicious target could
        // stream an endless/slow body to keep the action open and dodge an inactivity timeout. Destroy the
        // socket to discard the (never-read) body immediately.
        const status = res.statusCode ?? 0
        finish(() => resolve({ status, ok: status >= 200 && status < 300 }))
        res.destroy()
      },
    )
    req.on('error', (e: Error) => finish(() => reject(e)))
    req.on('timeout', () => {
      req.destroy(new Error('webhook request timed out'))
      finish(() => reject(new Error('webhook request timed out')))
    })
    if (typeof opts.body === 'string' && opts.body.length > 0) req.write(opts.body)
    req.end()
  })
}
