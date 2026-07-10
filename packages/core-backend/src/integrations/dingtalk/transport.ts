import { Logger } from '../../core/logger'

const logger = new Logger('DingTalkTransport')

/**
 * Unified DingTalk transport (roadmap §7.2, docs/development/dingtalk-sync-integrated-roadmap-20260708.md).
 *
 * ONE seam that every DingTalk HTTP call in `client.ts` goes through. It centralizes:
 *
 *  - the DT-HARDEN-06 per-request timeout — preserved, now composed PER ATTEMPT
 *    (each retry attempt gets its own fresh `AbortSignal.timeout`; a caller-supplied
 *    overall signal aborts the in-flight attempt AND any backoff wait immediately).
 *    The budget covers the whole attempt: a response BODY that stalls after headers
 *    arrived surfaces as the same DingTalkTimeoutError as a request-phase timeout;
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
 *    carry an {@link isDingTalkOutcomeUnknown} marker for ledger writers;
 *  - malformed-2xx guard: an HTTP-2xx response with an unusable body never
 *    normalizes to success — it throws {@link DingTalkMalformedResponseError}
 *    (a NEW shape; pre-fix such responses silently became `{}`/success, so no
 *    existing caller pattern-matched a shape for them).
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
 * An HTTP-2xx response whose body is UNUSABLE: not JSON (HTML error page, empty
 * body, truncated stream, bare primitive/array) or — for `envelope: 'oapi'`
 * endpoints — a JSON object MISSING the `errcode`/`code` discriminator the OAPI
 * envelope contract guarantees. Such a response must NEVER normalize to success
 * (the pre-fix behavior turned it into `{}` and reported success for a call whose
 * outcome is unusable). Classification is per tier: reads may retry it within the
 * attempt budget (transient proxy/CDN garbage), exchanges never retry, sends never
 * resend and carry the {@link isDingTalkOutcomeUnknown} marker — the request very
 * likely DID execute; only the response is unusable.
 *
 * `reason` is intentionally coarse ('unparseable_body' | 'missing_errcode') and the
 * message carries NO body content — a garbled body could contain anything.
 */
export class DingTalkMalformedResponseError extends Error {
  readonly httpStatus: number
  readonly reason: 'unparseable_body' | 'missing_errcode'

  constructor(reason: 'unparseable_body' | 'missing_errcode', httpStatus: number, fallbackError: string) {
    super(
      reason === 'missing_errcode'
        ? `${fallbackError}: DingTalk returned HTTP ${httpStatus} with a JSON body missing the errcode/code envelope discriminator`
        : `${fallbackError}: DingTalk returned HTTP ${httpStatus} with an unusable (non-JSON or non-object) body`,
    )
    this.name = 'DingTalkMalformedResponseError'
    this.httpStatus = httpStatus
    this.reason = reason
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
 * The failure classifier consults this set for EVERY tier, but only `'read'` calls
 * retry on a match; for `'send'`/`'exchange'` it only shapes the failure reason (a
 * flow-control envelope is a definite rejection, so it is never outcome-unknown).
 * See {@link DingTalkCallKind}.
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

/**
 * Structural (name-based) check rather than `instanceof Error`: abort reasons are
 * `DOMException`s, and DOMException only inherits from Error in recent Node versions
 * (late 18.x onward) — the supported floor is Node >=18.0.0.
 */
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * Body-phase abort detection. Current undici rejects an aborted body read with the
 * abort reason itself (AbortError / TimeoutError DOMException); Node 18's undici
 * wraps it as `TypeError: terminated` with the reason as `cause`. A `terminated`
 * whose cause is a socket error is NOT an abort — it falls through to network-error
 * classification.
 */
function isBodyAbortError(error: unknown): boolean {
  if (isAbortError(error)) return true
  if (typeof error !== 'object' || error === null) return false
  return isAbortError((error as { cause?: unknown }).cause)
}

/**
 * Read the response body as JSON under the SAME per-attempt budget as the request
 * itself: undici ties the body stream to the request signal, so a body that stalls
 * past the per-attempt timeout rejects here with the abort reason AFTER headers
 * already arrived. That MUST surface as DingTalkTimeoutError — identical
 * classification to a request-phase timeout (never retried; outcome-unknown on the
 * send tier) — and must never be swallowed into a `null` payload: on the ok-path a
 * swallowed body abort would normalize to `{}` and report SUCCESS for a call whose
 * outcome is unknown; on the non-ok path it would masquerade as a retryable
 * `http_<status>`. A genuinely non-JSON/non-object body (SyntaxError from
 * JSON.parse, bare primitive, top-level array) returns the tolerant `null` — the
 * OK-PATH then throws {@link DingTalkMalformedResponseError} instead of
 * normalizing it to `{}`/success, while the non-ok path keeps `responseBody: null`
 * on the DingTalkRequestError as before. Any other mid-body stream failure
 * (connection reset) rethrows raw and classifies as a network error.
 */
async function readJson(response: Response, timeoutMs: number): Promise<Record<string, unknown> | null> {
  try {
    const payload = await response.json()
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    if (isBodyAbortError(error)) {
      logger.warn(`DingTalk response body read aborted after ${timeoutMs}ms (headers received, body stalled)`)
      throw new DingTalkTimeoutError(timeoutMs)
    }
    throw error
  }
}

/**
 * OK-path (HTTP 2xx) envelope normalization. A `null` payload (unparseable body) is
 * a malformed response for EVERY envelope — never `{}`/success. For `'oapi'`
 * envelopes the errcode/code discriminator is REQUIRED (the OAPI contract always
 * carries `errcode: 0` on success; a 2xx JSON object without it is not a success
 * envelope — e.g. a proxy error page in JSON clothing); `'none'` (v1.0
 * api.dingtalk.com) endpoints have no discriminator, so any JSON object passes.
 */
function normalizeDingTalkApiPayload(
  payload: Record<string, unknown> | null,
  envelope: 'oapi' | 'none',
  httpStatus: number,
  fallbackError: string,
): Record<string, unknown> {
  if (payload === null) {
    throw new DingTalkMalformedResponseError('unparseable_body', httpStatus, fallbackError)
  }
  if (envelope === 'oapi') {
    const errcode = readNumericField(payload, 'errcode', 'code')
    if (errcode === null) {
      throw new DingTalkMalformedResponseError('missing_errcode', httpStatus, fallbackError)
    }
    if (errcode !== 0) {
      throw new DingTalkBusinessError(normalizeErrorMessage(payload, fallbackError), payload)
    }
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

interface PerAttemptSignal {
  signal: AbortSignal
  /**
   * Fallback-composition cleanup: detach the abort listeners once the attempt
   * settles, so a long-lived caller signal does not accumulate one listener per
   * attempt (`AbortSignal.any` manages its own internal registrations; the manual
   * fallback must clean up explicitly). No-op on the native / no-caller-signal paths.
   */
  dispose: () => void
}

const noopDispose = () => {}

/**
 * DT-HARDEN-06 composed per attempt: each attempt gets its OWN fresh timeout signal
 * (a retry must not start with an already-spent timeout budget); the caller's
 * overall signal aborts every attempt as well as the backoff sleeps. The composed
 * signal also governs the response BODY read (undici ties body streams to the
 * request signal), so the per-attempt budget covers headers AND body.
 */
function composePerAttemptSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): PerAttemptSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!callerSignal) return { signal: timeoutSignal, dispose: noopDispose }
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([callerSignal, timeoutSignal]), dispose: noopDispose }
  }
  // Pre-Node-20.3 fallback: manual AbortSignal.any — whichever of (caller signal,
  // per-attempt timeout) fires first aborts the attempt, with the same abort-reason
  // surface as the native path. NOTE an earlier revision returned the caller signal
  // alone here, silently dropping the per-attempt timeout whenever a caller passed
  // a signal on Node <20.3.
  const controller = new AbortController()
  const onCallerAbort = () => controller.abort(callerSignal.reason)
  const onTimeoutAbort = () => controller.abort(timeoutSignal.reason)
  if (callerSignal.aborted) {
    controller.abort(callerSignal.reason)
  } else if (timeoutSignal.aborted) {
    controller.abort(timeoutSignal.reason)
  } else {
    callerSignal.addEventListener('abort', onCallerAbort, { once: true })
    timeoutSignal.addEventListener('abort', onTimeoutAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      callerSignal.removeEventListener('abort', onCallerAbort)
      timeoutSignal.removeEventListener('abort', onTimeoutAbort)
    },
  }
}

async function performDingTalkAttempt(
  request: DingTalkTransportRequest,
  fetchFn: typeof fetch,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const { signal, dispose } = composePerAttemptSignal(callerSignal, timeoutMs)
  try {
    let response: Response
    try {
      response = await fetchFn(request.input, {
        ...request.init,
        signal,
      })
    } catch (error) {
      if (isAbortError(error)) {
        logger.warn(`DingTalk request timed out after ${timeoutMs}ms`)
        throw new DingTalkTimeoutError(timeoutMs)
      }
      throw error
    }

    const payload = await readJson(response, timeoutMs)

    if (!response.ok) {
      const message = normalizeErrorMessage(payload, request.fallbackError)
      logger.warn(`DingTalk request failed (${response.status}): ${message}`)
      const requestError = new DingTalkRequestError(message, response.status, payload)
      const retryAfterMs = parseRetryAfterMs(readResponseHeader(response, 'retry-after'))
      if (retryAfterMs !== null) retryAfterHints.set(requestError, retryAfterMs)
      throw requestError
    }

    return normalizeDingTalkApiPayload(payload, request.envelope, response.status, request.fallbackError)
  } finally {
    dispose()
  }
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
  if (error instanceof DingTalkMalformedResponseError) {
    // HTTP-2xx with an unusable body (or a 2xx oapi envelope missing its errcode
    // discriminator): the server very likely EXECUTED the request — only the
    // response is unusable. Per tier (owner-ratified, kept separate): reads may
    // retry within the existing attempt budget (transient proxy/CDN garbage, same
    // class as a 5xx-on-read); exchanges never retry (the single-use code may
    // already be redeemed); sends never resend and record outcome_unknown.
    return { error, reason: `malformed_response_${error.reason}`, retryable: isRead, retryAfterMs: null, outcomeUnknown: unknownIfSend }
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
