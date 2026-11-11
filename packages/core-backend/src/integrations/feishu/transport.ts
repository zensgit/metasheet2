import { AsyncLocalStorage } from 'async_hooks'
import { Logger } from '../../core/logger'
import { isFeishuUrlAllowed } from './endpoints'
import {
  FEISHU_FLOW_CONTROL_CODE,
  FeishuBusinessError,
  FeishuHostNotAllowedError,
  FeishuMalformedResponseError,
  FeishuRequestError,
  FeishuTimeoutError,
  markFeishuOutcomeUnknown,
  readFeishuCode,
} from './errors'

const logger = new Logger('FeishuTransport')

/**
 * The one exit for every outbound Feishu HTTP request.
 *
 * Each call site declares a tier; an undeclared call is an `exchange`, the tier that never retries:
 *
 *  - `read`     token minting, directory reads, user-information reads, the tenant query. Repeating one
 *               cannot apply anything twice.
 *  - `exchange` a single-use code exchange. No retry on any failure: a timeout or a dropped connection
 *               only proves that this client saw no answer, not that the code was not redeemed.
 *  - `send`     a request with an external side effect. No retry. A failure without a usable answer
 *               (network error, timeout, 5xx, a 2xx body that cannot be used) carries the outcome-unknown
 *               marker, because the message may have been accepted.
 *
 * Retry matrix (reads only unless stated):
 *   network error                         retried
 *   timeout, or a body that stalls        not retried (an abort cannot tell "still processing" from "never arrived")
 *   HTTP 429, or body code 99991400       retried after the server's reset hint (capped), else after a back-off
 *   HTTP 500/502/503/504, or body 20050/20072   retried
 *   HTTP 2xx with a body that is unusable retried
 *   HTTP 3xx                              never followed and never retried, on every tier
 *   any other code other than 0           thrown as a business error
 *
 * Redirects are not followed: every request carries `redirect: 'manual'` and a 3xx answer is a typed,
 * non-retryable failure. That keeps the Authorization header (and, on the token endpoint, the secret)
 * from following a redirect to a host outside the closed set. `redirect: 'error'` is not used: on this
 * runtime it rejects with a response-less TypeError, which would be classified as a network error and
 * retried, although a 3xx is a definite answer.
 *
 * Replaying a request after the tenant token was refused is NOT done here (see token.ts): this module
 * depends on endpoints and errors only, and never repeats a request on its own authority beyond the
 * matrix above.
 */
export const FEISHU_TRANSPORT_LIMITS = Object.freeze({
  maxAttempts: 3,
  backoffBaseMs: 300,
  backoffCapMs: 5_000,
  attemptTimeoutMs: 10_000,
  rateLimitWaitCapMs: 30_000,
})

export type FeishuCallKind = 'read' | 'exchange' | 'send'

/**
 * `open_api`: the answer is an envelope with a numeric `code`; a 2xx without one is unusable.
 * `oauth`: the token endpoint answers a success without a `code`; a `code` other than 0 is a failure.
 */
export type FeishuEnvelope = 'open_api' | 'oauth'

export interface FeishuTransportRequest {
  url: string
  init?: Omit<RequestInit, 'redirect' | 'signal'>
  kind?: FeishuCallKind
  envelope: FeishuEnvelope
  fetchFn?: typeof fetch
  /** Per-attempt budget, covering the headers and the body. */
  timeoutMs?: number
  /** Aborts the whole call, including a back-off wait. */
  signal?: AbortSignal
  /** Waits `ms`; resolves true when `signal` aborted first. Tests inject a recorder. */
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<boolean>
  random?: () => number
}

export interface FeishuTransportRetryEvent {
  reason: string
  /** 1-based index of the attempt that just failed. */
  attempt: number
  kind: FeishuCallKind
  delayMs: number
}

export type FeishuTransportRetryObserver = (event: FeishuTransportRetryEvent) => void

const retryObserverStorage = new AsyncLocalStorage<FeishuTransportRetryObserver>()

/**
 * Runs `fn` with an observer for every retry the transport decides to make inside its async context.
 * Observation only: an observer that throws is ignored and cannot change a decision or an error.
 */
export function observeFeishuTransportRetries<T>(observer: FeishuTransportRetryObserver, fn: () => Promise<T>): Promise<T> {
  return retryObserverStorage.run(observer, fn)
}

const RETRYABLE_READ_5XX: ReadonlySet<number> = new Set([500, 502, 503, 504])
const BODY_CODE_SERVER_ERROR: Readonly<Record<number, number>> = Object.freeze({ 20050: 500, 20072: 503 })
const RATE_LIMIT_RESET_HEADER = 'x-ogw-ratelimit-reset'

const rateLimitResetHints = new WeakMap<object, number>()

function readHeader(response: Response, name: string): string | null {
  const headers = (response as Partial<Response>).headers
  if (!headers || typeof headers.get !== 'function') return null
  try {
    return headers.get(name)
  } catch {
    return null
  }
}

function parseResetSeconds(raw: string | null): number | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

function isBodyAbortError(error: unknown): boolean {
  if (isAbortError(error)) return true
  if (typeof error !== 'object' || error === null) return false
  return isAbortError((error as { cause?: unknown }).cause)
}

/**
 * Reads the body as JSON under the attempt's own budget. A body that stalls after the headers arrived
 * ends in the same FeishuTimeoutError as a request-phase timeout. A body that is not a JSON object is
 * `null`; any other stream failure is rethrown and classified as a network error.
 */
async function readJson(response: Response, timeoutMs: number): Promise<Record<string, unknown> | null> {
  try {
    const payload = await response.json()
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    if (isBodyAbortError(error)) throw new FeishuTimeoutError(timeoutMs)
    throw error
  }
}

function discardBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined)
  } catch {
    // nothing to release
  }
}

function normalizeOk(
  payload: Record<string, unknown> | null,
  envelope: FeishuEnvelope,
  httpStatus: number,
): Record<string, unknown> {
  if (payload === null) throw new FeishuMalformedResponseError('unparseable_body', httpStatus)
  const code = readFeishuCode(payload)
  if (envelope === 'open_api' && code === null) throw new FeishuMalformedResponseError('missing_code', httpStatus)
  if (code !== null && code !== 0) throw new FeishuBusinessError(code, httpStatus, payload)
  return payload
}

async function performAttempt(
  request: FeishuTransportRequest,
  fetchFn: typeof fetch,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onCallerAbort = () => controller.abort()
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  try {
    let response: Response
    let payload: Record<string, unknown> | null
    try {
      response = await fetchFn(request.url, { ...request.init, redirect: 'manual', signal: controller.signal })
      if (response.status >= 300 && response.status < 400) {
        discardBody(response)
        throw new FeishuRequestError(response.status, null)
      }
      payload = await readJson(response, timeoutMs)
    } catch (error) {
      if (isAbortError(error)) throw new FeishuTimeoutError(timeoutMs)
      throw error
    }

    const status = response.status
    if (status >= 200 && status < 300) return normalizeOk(payload, request.envelope, status)

    const code = readFeishuCode(payload)
    let failure: Error
    if (status === 429) {
      failure = new FeishuRequestError(status, payload)
    } else if (code === FEISHU_FLOW_CONTROL_CODE) {
      failure = new FeishuBusinessError(code, status, payload)
    } else if (status >= 500 && status < 600) {
      failure = new FeishuRequestError(status, payload)
    } else if (code !== null && code !== 0) {
      failure = new FeishuBusinessError(code, status, payload)
    } else {
      failure = new FeishuRequestError(status, payload)
    }
    const resetSeconds = parseResetSeconds(readHeader(response, RATE_LIMIT_RESET_HEADER))
    if (resetSeconds !== null) rateLimitResetHints.set(failure, resetSeconds)
    throw failure
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
}

interface FailureClassification {
  error: unknown
  reason: string
  retryable: boolean
  /** Seconds the server asked us to wait, when it said. */
  resetSeconds: number | null
  outcomeUnknown: boolean
}

function classifyFailure(error: unknown, kind: FeishuCallKind): FailureClassification {
  const isRead = kind === 'read'
  const unknownIfSend = kind === 'send'

  if (error instanceof FeishuTimeoutError) {
    return { error, reason: 'timeout', retryable: false, resetSeconds: null, outcomeUnknown: unknownIfSend }
  }
  if (error instanceof FeishuRequestError) {
    const status = error.statusCode
    if (status >= 300 && status < 400) {
      return { error, reason: `http_${status}`, retryable: false, resetSeconds: null, outcomeUnknown: false }
    }
    const resetSeconds = rateLimitResetHints.get(error) ?? null
    if (status === 429) return { error, reason: 'http_429', retryable: isRead, resetSeconds, outcomeUnknown: false }
    if (status >= 500 && status < 600) {
      return { error, reason: `http_${status}`, retryable: isRead && RETRYABLE_READ_5XX.has(status), resetSeconds: null, outcomeUnknown: unknownIfSend }
    }
    return { error, reason: `http_${status}`, retryable: false, resetSeconds: null, outcomeUnknown: false }
  }
  if (error instanceof FeishuBusinessError) {
    if (error.code === FEISHU_FLOW_CONTROL_CODE) {
      return {
        error,
        reason: `flow_control_errcode_${error.code}`,
        retryable: isRead,
        resetSeconds: rateLimitResetHints.get(error) ?? null,
        outcomeUnknown: false,
      }
    }
    const serverStatus = BODY_CODE_SERVER_ERROR[error.code]
    if (serverStatus !== undefined) {
      return { error, reason: `http_${serverStatus}`, retryable: isRead, resetSeconds: null, outcomeUnknown: unknownIfSend }
    }
    return { error, reason: 'business_error', retryable: false, resetSeconds: null, outcomeUnknown: false }
  }
  if (error instanceof FeishuMalformedResponseError) {
    return { error, reason: `malformed_response_${error.reason}`, retryable: isRead, resetSeconds: null, outcomeUnknown: unknownIfSend }
  }
  return { error, reason: 'network_error', retryable: isRead, resetSeconds: null, outcomeUnknown: unknownIfSend }
}

function backoffDelayMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(FEISHU_TRANSPORT_LIMITS.backoffCapMs, FEISHU_TRANSPORT_LIMITS.backoffBaseMs * 2 ** (attempt - 1))
  return Math.trunc(random() * ceiling)
}

function retryDelayMs(failure: FailureClassification, attempt: number, random: () => number): number {
  const isRateLimit = failure.reason === 'http_429' || failure.reason.startsWith('flow_control_errcode_')
  if (isRateLimit && failure.resetSeconds !== null) {
    return Math.min(FEISHU_TRANSPORT_LIMITS.rateLimitWaitCapMs, Math.trunc(failure.resetSeconds * 1000))
  }
  return backoffDelayMs(attempt, random)
}

function defaultSleep(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true)
  if (delayMs <= 0) return Promise.resolve(false)
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(false)
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The transport seam. A target outside the closed host set is refused before any request is made.
 * When retries are exhausted, or a failure is not retryable, the original typed error is thrown (on the
 * send tier a failure without a usable answer carries the outcome-unknown marker).
 */
export async function requestFeishuJson(request: FeishuTransportRequest): Promise<Record<string, unknown>> {
  if (!isFeishuUrlAllowed(request.url)) throw new FeishuHostNotAllowedError()

  const kind: FeishuCallKind = request.kind ?? 'exchange'
  const timeoutMs = request.timeoutMs ?? FEISHU_TRANSPORT_LIMITS.attemptTimeoutMs
  const callerSignal = request.signal
  const random = request.random ?? Math.random
  const sleep = request.sleep ?? defaultSleep

  for (let attempt = 1; ; attempt++) {
    if (callerSignal?.aborted) throw new FeishuTimeoutError(timeoutMs)

    // Resolved at call time so a wrapper installed on the global is the one used.
    const fetchFn = request.fetchFn ?? fetch

    let failure: FailureClassification
    try {
      return await performAttempt(request, fetchFn, timeoutMs, callerSignal)
    } catch (error) {
      failure = classifyFailure(error, kind)
    }

    if (!failure.retryable || attempt >= FEISHU_TRANSPORT_LIMITS.maxAttempts || callerSignal?.aborted) {
      if (failure.outcomeUnknown) markFeishuOutcomeUnknown(failure.error)
      throw failure.error
    }

    const delayMs = retryDelayMs(failure, attempt, random)
    logger.warn(
      `Feishu transport retry ${attempt + 1}/${FEISHU_TRANSPORT_LIMITS.maxAttempts} after ${failure.reason} (${kind}): backing off ${delayMs}ms`,
    )
    const observer = retryObserverStorage.getStore()
    if (observer) {
      try {
        observer({ reason: failure.reason, attempt, kind, delayMs })
      } catch {
        // telemetry only
      }
    }
    if (await sleep(delayMs, callerSignal)) throw new FeishuTimeoutError(timeoutMs)
  }
}
