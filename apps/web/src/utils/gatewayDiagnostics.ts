import { createGatewayInterferenceError, hasHttpResponse, isNetworkUnavailableError, isZhLocale, safeGatewayRequestId } from './networkErrors'

export const GATEWAY_HEALTH_WINDOW_MS = 60_000

type GatewayRequest = {
  origin: string
  method: string
  requestId: string
  requestIdSent: boolean
}

type GatewayResponse = {
  request: GatewayRequest
  onJson?: (body: unknown) => void
}

const healthyOrigins = new Map<string, number>()
const responses = new WeakMap<Response, GatewayResponse>()
let requestSequence = 0

export function gatewayRequest(input: string, init?: RequestInit, headers?: Headers): GatewayRequest | undefined {
  let url: URL
  try {
    url = new URL(input, window.location.origin)
  } catch {
    return undefined
  }
  if (!/^https?:$/.test(url.protocol) || !url.pathname.startsWith('/api/')) return undefined
  const suppliedId = safeGatewayRequestId(headers?.get('x-request-id'))
  const requestId = suppliedId ?? globalThis.crypto?.randomUUID?.()
    ?? `web-${Date.now().toString(36)}-${(++requestSequence).toString(36)}`
  if (headers && url.origin === window.location.origin) headers.set('x-request-id', requestId)
  return {
    origin: url.origin,
    method: (init?.method ?? 'GET').toUpperCase(),
    requestId,
    requestIdSent: Boolean(suppliedId || (headers && url.origin === window.location.origin)),
  }
}

export function rememberGatewayResponse(response: Response, request: GatewayRequest | undefined, onJson?: (body: unknown) => void): void {
  if (request && !responses.has(response)) responses.set(response, { request, onJson })
}

export function gatewayTransportError(
  error: unknown,
  request: GatewayRequest | undefined,
  signal?: AbortSignal | null,
  isZh = isZhLocale(),
): unknown {
  if (!request || signal?.aborted || (typeof navigator !== 'undefined' && navigator.onLine === false)) return error
  const failure = error as { name?: unknown } | null
  if (failure?.name === 'AbortError' || hasHttpResponse(error)) return error
  if (failure?.name !== 'TypeError' && !isNetworkUnavailableError(error)) return error
  const healthyAt = healthyOrigins.get(request.origin)
  const age = healthyAt === undefined ? Infinity : Date.now() - healthyAt
  if (age < 0 || age > GATEWAY_HEALTH_WINDOW_MS) return error
  return createGatewayInterferenceError(0, request.requestId, isZh, request.requestIdSent ? 'request' : 'local')
}

export async function readGatewayJson(response: Response, isZh = isZhLocale()): Promise<{ raw: string; body: unknown; validJson: boolean }> {
  const raw = await response.text()
  let body: unknown = null
  let validJson = false
  try {
    body = JSON.parse(raw)
    validJson = true
  } catch {
    validJson = false
  }
  const context = responses.get(response)
  if (context) {
    const failedNonJson = response.status >= 400 && response.status <= 599 && !validJson
    if (raw.includes('\u0000') || failedNonJson) {
      const responseId = safeGatewayRequestId(response.headers.get('x-request-id'))
      throw createGatewayInterferenceError(
        response.status,
        responseId ?? context.request.requestId,
        isZh,
        responseId ? 'response' : context.request.requestIdSent ? 'request' : 'local',
      )
    }
    if (validJson) {
      context.onJson?.(body)
      const failedEnvelope = body && typeof body === 'object'
        && (('ok' in body && body.ok === false) || ('success' in body && body.success === false))
      if (context.request.method === 'GET' && response.ok && !response.redirected && !failedEnvelope) {
        healthyOrigins.set(context.request.origin, Date.now())
      }
    }
  }
  return { raw, body, validJson }
}
