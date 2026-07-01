import https from 'node:https'
import type { IncomingMessage } from 'node:http'

import type {
  PinnedEgressRequest,
  PinnedEgressResponse,
  PinnedEgressTransport,
} from './egress-dispatcher'

export type HttpsRequestFn = typeof https.request

export interface PinnedHttpsJsonTransportOptions {
  timeoutMs?: number
  maxResponseBytes?: number
  requestImpl?: HttpsRequestFn
}

export const DEFAULT_PINNED_HTTPS_JSON_TIMEOUT_MS = 5_000
export const DEFAULT_PINNED_HTTPS_JSON_MAX_RESPONSE_BYTES = 1024 * 1024

function stripCallerHost(headers: Readonly<Record<string, string>>): Record<string, string> {
  const safeHeaders: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'host') continue
    safeHeaders[key] = value
  }
  return safeHeaders
}

function responseHeaders(res: IncomingMessage): PinnedEgressResponse['headers'] {
  const headers: Record<string, string | readonly string[] | undefined> = {}
  for (const [key, value] of Object.entries(res.headers)) {
    if (typeof value === 'number') {
      headers[key] = String(value)
    } else {
      headers[key] = value
    }
  }
  return headers
}

function parseJsonResponse(raw: string): unknown {
  if (raw.length === 0) return null
  return JSON.parse(raw) as unknown
}

export function createPinnedHttpsJsonTransport(
  options: PinnedHttpsJsonTransportOptions = {},
): PinnedEgressTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PINNED_HTTPS_JSON_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_PINNED_HTTPS_JSON_MAX_RESPONSE_BYTES
  const requestImpl = options.requestImpl ?? https.request

  return async (request) => pinnedHttpsJsonRequest(request, { timeoutMs, maxResponseBytes, requestImpl })
}

export async function pinnedHttpsJsonRequest(
  request: PinnedEgressRequest,
  options: Required<PinnedHttpsJsonTransportOptions>,
): Promise<PinnedEgressResponse> {
  return await new Promise<PinnedEgressResponse>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    const url = new URL(request.normalizedUrl)
    const safeHeaders = stripCallerHost(request.headers)
    safeHeaders.host = url.host

    const req = options.requestImpl(
      request.normalizedUrl,
      {
        method: request.method,
        headers: safeHeaders,
        timeout: options.timeoutMs,
        servername: request.hostname,
        lookup: (_hostname: string, _options: unknown, cb: (err: Error | null, address: string, family: number) => void) => {
          cb(null, request.pinnedAddress, request.family)
        },
      } as https.RequestOptions,
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0
        const chunks: Buffer[] = []
        let totalBytes = 0

        res.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          totalBytes += buffer.length
          if (totalBytes > options.maxResponseBytes) {
            const error = new Error('pinned egress response exceeded size limit')
            res.destroy(error)
            finish(() => reject(error))
            return
          }
          chunks.push(buffer)
        })

        res.on('end', () => {
          finish(() => {
            try {
              resolve({
                status,
                headers: responseHeaders(res),
                body: parseJsonResponse(Buffer.concat(chunks).toString('utf8')),
              })
            } catch {
              reject(new Error('pinned egress response JSON parse failed'))
            }
          })
        })

        res.on('error', (error: Error) => finish(() => reject(error)))
      },
    )

    req.on('error', (error: Error) => finish(() => reject(error)))
    req.on('timeout', () => {
      const error = new Error('pinned egress request timed out')
      req.destroy(error)
      finish(() => reject(error))
    })

    if (typeof request.body === 'string' && request.body.length > 0) req.write(request.body)
    req.end()
  })
}
