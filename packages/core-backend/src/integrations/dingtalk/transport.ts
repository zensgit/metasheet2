import { Logger } from '../../core/logger'

const logger = new Logger('DingTalkTransport')

/**
 * Unified DingTalk transport (roadmap §7.2, docs/development/dingtalk-sync-integrated-roadmap-20260708.md).
 *
 * ONE seam that every DingTalk HTTP call in `client.ts` goes through. It centralizes:
 *
 *  - the DT-HARDEN-06 per-request timeout — preserved, now composed PER ATTEMPT
 *    (each retry attempt gets its own fresh `AbortSignal.timeout`; a caller-supplied
 *    overall signal aborts the in-flight attempt AND any backoff wait immediately);
 *  - bounded retry with exponential backoff + full jitter, honoring `Retry-After`;
 *  - explicit BUSINESS-SEMANTICS classification per call site (see
 *    {@link DingTalkCallKind}) — never inferred from the HTTP verb;
 *  - DingTalk flow-control recognition: HTTP 429 as well as HTTP-200 envelopes
 *    carrying flow-control errcodes (see {@link isDingTalkFlowControlErrcode});
 *  - error-shape preservation: when retries are exhausted or a failure is
 *    non-retryable, the SAME error is thrown that the pre-retry client threw
 *    (DingTalkRequestError / DingTalkBusinessError / DingTalkTimeoutError / the raw
 *    network error). Callers pattern-match on these shapes (routes/auth.ts,
 *    multitable/automation-executor.ts, AttendanceNotificationDeliveryWorker) —
 *    do not wrap or re-type them here. Send-tier uncertain outcomes additionally
 *    carry an {@link isDingTalkOutcomeUnknown} marker for ledger writers.
 *
 * Rate-limit handling here (backoff on 429/flow-control) is BEST-EFFORT and
 * in-process only: replicas do not share a quota. Multi-replica shared throttling
 * (per app/corp, Redis or equivalent) is explicitly out of scope — follow-up work.
 */

export class DingTalkRequestError extends Error {
  statusCode: number
  responseBody: Record<string, unknown> | null

  constructor(message: string, statusCode: number, responseBody: Record<string, unknown> | null) {
    super(message)
    this.name = 'DingTalkRequestError'
    this.statusCode = statusCode
    this.responseBody = responseBody
  }
}

export class DingTalkBusinessError extends Error {
  responseBody: Record<string, unknown> | null

  constructor(message: string, responseBody: Record<string, unknown> | null) {
    super(message)
    this.name = 'DingTalkBusinessError'
    this.responseBody = responseBody
  }
}

/**
 * DT-HARDEN-06: every DingTalk call that is not the group-robot webhook goes through
 * here — gettoken, directory sync, work notifications, approval cards, container
 * login. They used a naked `fetch` with no timeout, so a hung connection blocked an
 * inline automation execution or a whole directory sync for as long as undici's
 * default (~300s). Bound them, and surface the timeout as a typed operational error
 * so callers record a failed run/delivery instead of hanging.
 */
export const DINGTALK_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.DINGTALK_REQUEST_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 10_000
})()

export class DingTalkTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`DingTalk request timed out after ${timeoutMs}ms`)
    this.name = 'DingTalkTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/**
 * Business-semantics classification — chosen EXPLICITLY at every call site, never
 * inferred from the HTTP verb (roadmap §7.2: "Retry only safe/idempotent API
 * classes", "Keep work-notification sends bounded and classified"):
 *
 *  - `'read'` — SAFE READS: token GET, user/department gets, and directory
 *    query-shaped POSTs that only read (listsub, user/list, user/get,
 *    department/get). Repeating them cannot double-apply anything. Retried on:
 *    network error, HTTP 429, selected transient 5xx (500/502/503/504), and
 *    flow-control errcodes inside HTTP-200 envelopes.
 *
 *  - `'exchange'` — ONE-SHOT EXCHANGES: OAuth authorization-code exchange, E1
 *    container-login authCode. The code is single-use; a retry after an ambiguous
 *    failure burns it or double-redeems. NO retry on ANY failure — a fetch
 *    timeout/disconnect only proves the CLIENT saw no response, not that DingTalk
 *    didn't receive and execute the request.
 *
 *  - `'send'` — SIDE-EFFECT SENDS: asyncsend_v2 work notifications / action cards.
 *    On network error, timeout, or 5xx the outcome is UNKNOWN — DingTalk may have
 *    delivered the message even though we saw no response — so the transport does
 *    NOT resend; it rethrows the original error marked via
 *    {@link isDingTalkOutcomeUnknown} (and `outcomeUnknown: true` on the error)
 *    so ledger writers can record `outcome_unknown` instead of a plain failure.
 *    Note DingTalk's async-send result query (by task_id) can reconcile a KNOWN
 *    send, but when the response was lost there IS no task_id — it cannot serve
 *    as an idempotency key for auto-retry. HTTP 429 on sends is a definite
 *    pre-processing rejection, but auto-retry is deliberately NOT enabled in this
 *    slice pending endpoint-contract confirmation; it fails through unchanged.
 *
 * Unclassified call sites default to `'exchange'` — the most conservative tier
 * (no retry at all).
 *
 * Per-attempt timeouts (DingTalkTimeoutError) are NOT retried for any tier: an
 * abort cannot distinguish "server still processing" from "request never arrived",
 * and retrying would multiply DT-HARDEN-06's bounded wall-time by the attempt count.
 */
export type DingTalkCallKind = 'read' | 'exchange' | 'send'

export interface DingTalkTransportConfig {
  /** Total attempts including the first one (1 = no retries). */
  maxAttempts: number
  backoffBaseMs: number
  backoffCapMs: number
}

export const DINGTALK_TRANSPORT_DEFAULTS: Readonly<DingTalkTransportConfig> = Object.freeze({
  maxAttempts: 3,
  backoffBaseMs: 300,
  backoffCapMs: 5_000,
})

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 1) return fallback
  return Math.trunc(value)
}

/**
 * Env-tunable retry knobs. Read at call time (not module load) so tests and ops
 * overrides apply without a module reload; invalid or absent values fall back to
 * {@link DINGTALK_TRANSPORT_DEFAULTS}.
 */
export function resolveDingTalkTransportConfig(): DingTalkTransportConfig {
  return {
    maxAttempts: readPositiveIntEnv('DINGTALK_TRANSPORT_MAX_ATTEMPTS', DINGTALK_TRANSPORT_DEFAULTS.maxAttempts),
    backoffBaseMs: readPositiveIntEnv('DINGTALK_TRANSPORT_BACKOFF_BASE_MS', DINGTALK_TRANSPORT_DEFAULTS.backoffBaseMs),
    backoffCapMs: readPositiveIntEnv('DINGTALK_TRANSPORT_BACKOFF_CAP_MS', DINGTALK_TRANSPORT_DEFAULTS.backoffCapMs),
  }
}

/**
 * Flow-control / transient errcodes DingTalk returns inside HTTP-200 envelopes
 * ("the call was rejected for quota/availability, back off and retry"):
 *
 *  - `90018` — DingTalk's documented flow-control (频率超限) errcode family;
 *  - `-1`    — DingTalk "system busy" (系统繁忙, 稍后重试);
 *  - `408 / 429 / 5xx / 50001` — kept in parity with what the repo's delivery layer
 *    already treats as retryable (`AttendanceNotificationDeliveryWorker`'s
 *    `isRetryableDingTalkErrorCode`: HTTP-ish echoes some endpoints place in the
 *    envelope `code` field), so the transport never retries a class the delivery
 *    layer considers permanent, and vice versa.
 *
 * Only consulted for `'read'` calls — see {@link DingTalkCallKind}.
 */
export function isDingTalkFlowControlErrcode(code: number): boolean {
  return code === 90018
    || code === -1
    || code === 408
    || code === 429
    || (code >= 500 && code < 600)
    || code === 50001
}

/**
 * Selected transient 5xx statuses retried for `'read'` calls. 501/505/… are
 * permanent contract errors, not blips — retrying them only burns quota.
 */
const RETRYABLE_READ_5XX: ReadonlySet<number> = new Set([500, 502, 503, 504])

/**
 * Send-tier uncertain-outcome marker: the request MAY have been executed by
 * DingTalk although the client saw no (usable) response. Ledger writers should
 * record such failures as `outcome_unknown` rather than a plain failure. The
 * original error object is thrown UNCHANGED apart from an added
 * `outcomeUnknown: true` property; this guard also works for frozen/exotic
 * errors via a WeakSet.
 */
const outcomeUnknownErrors = new WeakSet<object>()

export function isDingTalkOutcomeUnknown(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if (outcomeUnknownErrors.has(error)) return true
  return (error as { outcomeUnknown?: unknown }).outcomeUnknown === true
}

function markOutcomeUnknown(error: unknown): void {
  if (typeof error !== 'object' || error === null) return
  outcomeUnknownErrors.add(error)
  try {
    Object.defineProperty(error, 'outcomeUnknown', { value: true, enumerable: true, configurable: true })
  } catch {
    // frozen error object — the WeakSet still answers isDingTalkOutcomeUnknown
  }
}

/**
 * Parse a `Retry-After` header value: delay-seconds (RFC 9110 §10.2.3) or an
 * HTTP-date. Returns milliseconds, or null when absent/unparseable.
 */
export function parseRetryAfterMs(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.trunc(seconds * 1000) : null
  }
  const dateMs = Date.parse(raw)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now())
  return null
}

/**
 * Exponential backoff with FULL jitter: `random() * min(cap, base * 2^(attempt-1))`.
 * A server-provided `Retry-After` overrides the jittered delay (it is the server's
 * explicit floor), clamped to the cap so a huge/hostile header cannot stall a sync
 * worker beyond the configured bound.
 *
 * @param attempt 1-based index of the attempt that just FAILED.
 */
export function computeDingTalkRetryDelayMs(
  attempt: number,
  config: DingTalkTransportConfig,
  retryAfterMs: number | null,
  randomFn: () => number = Math.random,
): number {
  if (retryAfterMs !== null) return Math.min(config.backoffCapMs, retryAfterMs)
  const ceiling = Math.min(config.backoffCapMs, config.backoffBaseMs * 2 ** (attempt - 1))
  return Math.trunc(randomFn() * ceiling)
}

export interface DingTalkTransportRequest {
  input: string
  init: RequestInit
  fallbackError: string
  /**
   * Business-semantics tier chosen at the call site (see {@link DingTalkCallKind}).
   * Omitted/unknown defaults to `'exchange'` — the most conservative tier (no retry).
   */
  kind?: DingTalkCallKind
  /**
   * `'oapi'`: legacy oapi.dingtalk.com envelope endpoints — an `errcode !== 0` in an
   * HTTP-200 body throws DingTalkBusinessError INSIDE the retry loop, so flow-control
   * errcodes can back off on reads. `'none'`: v1.0 api.dingtalk.com endpoints
   * (HTTP-status based, no envelope).
   */
  envelope: 'oapi' | 'none'
  fetchFn?: typeof fetch
  /** Override the default per-attempt timeout (DT-HARDEN-06). */
  timeoutMs?: number
  /** Caller's OVERALL signal: aborts the whole retry loop (incl. mid-backoff) immediately. */
  signal?: AbortSignal
}

export function normalizeErrorMessage(payload: Record<string, unknown> | null, fallback: string): string {
  if (!payload) return fallback
  const candidates = [
    payload.message,
    payload.msg,
    payload.error_description,
    payload.errorDescription,
    payload.error,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return fallback
}

export function readNumericField(payload: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'number') return value
    if (typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Number(value))) {
      return Number(value)
    }
  }
  return null
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const payload = await response.json()
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  } catch {
    return null
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function normalizeDingTalkApiPayload(payload: Record<string, unknown>, fallbackError: string): Record<string, unknown> {
  const errcode = readNumericField(payload, 'errcode', 'code')
  if (errcode !== null && errcode !== 0) {
    throw new DingTalkBusinessError(normalizeErrorMessage(payload, fallbackError), payload)
  }
  return payload
}

/** Unit-test fakes may hand us a headerless `Response`-shaped object — stay defensive. */
function readResponseHeader(response: Response, name: string): string | null {
  const headers = (response as Partial<Response>).headers
  if (!headers || typeof headers.get !== 'function') return null
  try {
    return headers.get(name)
  } catch {
    return null
  }
}

/**
 * `Retry-After` hints ride next to the thrown DingTalkRequestError without changing
 * its shape (callers pattern-match on `statusCode`/`responseBody`).
 */
const retryAfterHints = new WeakMap<object, number>()

/**
 * DT-HARDEN-06 composed per attempt: each attempt gets its OWN fresh timeout signal
 * (a retry must not start with an already-spent timeout budget); the caller's
 * overall signal aborts every attempt as well as the backoff sleeps.
 */
function composePerAttemptSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!callerSignal) return timeoutSignal
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([callerSignal, timeoutSignal])
  // Pre-Node-20.3 fallback: preserve the pre-retry precedence (caller signal wins).
  return callerSignal
}

async function performDingTalkAttempt(
  request: DingTalkTransportRequest,
  fetchFn: typeof fetch,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetchFn(request.input, {
      ...request.init,
      signal: composePerAttemptSignal(callerSignal, timeoutMs),
    })
  } catch (error) {
    if (isAbortError(error)) {
      logger.warn(`DingTalk request timed out after ${timeoutMs}ms`)
      throw new DingTalkTimeoutError(timeoutMs)
    }
    throw error
  }

  const payload = await readJson(response)

  if (!response.ok) {
    const message = normalizeErrorMessage(payload, request.fallbackError)
    logger.warn(`DingTalk request failed (${response.status}): ${message}`)
    const requestError = new DingTalkRequestError(message, response.status, payload)
    const retryAfterMs = parseRetryAfterMs(readResponseHeader(response, 'retry-after'))
    if (retryAfterMs !== null) retryAfterHints.set(requestError, retryAfterMs)
    throw requestError
  }

  if (request.envelope === 'oapi') {
    return normalizeDingTalkApiPayload(payload ?? {}, request.fallbackError)
  }
  return payload ?? {}
}

interface DingTalkFailureClassification {
  error: unknown
  reason: string
  retryable: boolean
  retryAfterMs: number | null
  /** Send-tier only: the request may have been executed although we saw no response. */
  outcomeUnknown: boolean
}

/** The explicit retry matrix — see {@link DingTalkCallKind} for the tier rationale. */
function classifyDingTalkFailure(error: unknown, kind: DingTalkCallKind): DingTalkFailureClassification {
  const isRead = kind === 'read'
  // Uncertain outcomes (no usable response: timeout / network error / 5xx) get the
  // outcome-unknown marker on the send tier so ledger writers can distinguish
  // "maybe delivered" from "definitely rejected".
  const unknownIfSend = kind === 'send'

  if (error instanceof DingTalkTimeoutError) {
    // Timeout/abort: the request MAY be processing server-side. Never retried.
    return { error, reason: 'timeout', retryable: false, retryAfterMs: null, outcomeUnknown: unknownIfSend }
  }
  if (error instanceof DingTalkRequestError) {
    const retryAfterMs = retryAfterHints.get(error) ?? null
    if (error.statusCode === 429) {
      // Definite pre-processing rejection. Retried on reads only: send-tier 429
      // auto-retry is deliberately NOT enabled in this slice (endpoint-contract
      // confirmation pending); exchanges never retry.
      return { error, reason: 'http_429', retryable: isRead, retryAfterMs, outcomeUnknown: false }
    }
    if (error.statusCode >= 500 && error.statusCode < 600) {
      // Server-side failure AFTER the request arrived — a send may already have
      // been executed. Only selected transient 5xx are retried, reads only.
      return {
        error,
        reason: `http_${error.statusCode}`,
        retryable: isRead && RETRYABLE_READ_5XX.has(error.statusCode),
        retryAfterMs,
        outcomeUnknown: unknownIfSend,
      }
    }
    return { error, reason: `http_${error.statusCode}`, retryable: false, retryAfterMs: null, outcomeUnknown: false }
  }
  if (error instanceof DingTalkBusinessError) {
    const errcode = readNumericField(error.responseBody ?? {}, 'errcode', 'code')
    if (errcode !== null && isDingTalkFlowControlErrcode(errcode)) {
      // HTTP-200 flow-control envelope: a definite app-layer rejection (we DID get
      // a response), so it is not outcome-unknown — but only reads retry it.
      return { error, reason: `flow_control_errcode_${errcode}`, retryable: isRead, retryAfterMs: null, outcomeUnknown: false }
    }
    return { error, reason: 'business_error', retryable: false, retryAfterMs: null, outcomeUnknown: false }
  }
  // fetch rejected without producing a response (DNS/conn-refused/reset). Reads may
  // retry; exchanges never (single-use code may have been redeemed server-side);
  // sends never (the notification may have gone out) — outcome unknown.
  return { error, reason: 'network_error', retryable: isRead, retryAfterMs: null, outcomeUnknown: unknownIfSend }
}

/** Resolves `true` when the signal aborted before the delay elapsed. */
function sleepUnlessAborted(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
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
 * The transport seam. Every DingTalk outbound call in `client.ts` funnels through
 * this function — do NOT add per-call-site retry loops on top of it.
 */
export async function requestDingTalkTransportJson(request: DingTalkTransportRequest): Promise<Record<string, unknown>> {
  const config = resolveDingTalkTransportConfig()
  const timeoutMs = request.timeoutMs ?? DINGTALK_REQUEST_TIMEOUT_MS
  const callerSignal = request.signal ?? request.init.signal ?? undefined
  const fetchFn = request.fetchFn ?? fetch
  // Unclassified defaults to the most conservative tier: no retry at all.
  const kind: DingTalkCallKind = request.kind ?? 'exchange'

  for (let attempt = 1; ; attempt++) {
    if (callerSignal?.aborted) {
      // Preserve the pre-retry abort surface: aborts appear as DingTalkTimeoutError.
      throw new DingTalkTimeoutError(timeoutMs)
    }

    let failure: DingTalkFailureClassification
    try {
      return await performDingTalkAttempt(request, fetchFn, timeoutMs, callerSignal)
    } catch (error) {
      failure = classifyDingTalkFailure(error, kind)
    }

    if (!failure.retryable || attempt >= config.maxAttempts || callerSignal?.aborted) {
      // Exhausted or non-retryable: rethrow the ORIGINAL error unchanged — callers
      // pattern-match on the pre-retry shapes. Send-tier uncertain outcomes get the
      // outcome-unknown marker (additive property; shape otherwise identical).
      if (failure.outcomeUnknown) markOutcomeUnknown(failure.error)
      throw failure.error
    }

    const delayMs = computeDingTalkRetryDelayMs(attempt, config, failure.retryAfterMs)
    logger.warn(
      `DingTalk transport retry ${attempt + 1}/${config.maxAttempts} after ${failure.reason} (${kind}): backing off ${delayMs}ms`,
    )
    const aborted = await sleepUnlessAborted(delayMs, callerSignal)
    if (aborted) {
      throw new DingTalkTimeoutError(timeoutMs)
    }
  }
}
