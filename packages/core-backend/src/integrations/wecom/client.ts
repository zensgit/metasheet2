import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { Logger } from '../../core/logger'

const logger = new Logger('WeComClient')

/**
 * S4 WeCom (企业微信) work-notification delivery channel — transport layer.
 * design-lock: attendance-wecom-delivery-channel-s4-design-lock-20260710.
 *
 * API facts locked in the design-lock (verified against WeCom's official docs, not memory):
 *  - Token: GET /cgi-bin/gettoken?corpid=&corpsecret= ; expires_in ~7200s; must be cached AND
 *    re-fetched on early invalidation (official guidance: "可能提前失效，应实现失效重取").
 *  - Send: POST /cgi-bin/message/send?access_token= ; touser (|-joined), agentid (integer),
 *    msgtype. textcard {title<=128 chars, description<=512 chars, url<=2048 bytes w/ protocol,
 *    btntxt<=4 chars} is the deep-link equivalent; text {content<=2048 bytes}. markdown is
 *    intentionally NOT used — WeCom's official docs state the mobile "微工作台" surface does not
 *    render markdown work-notification messages.
 *  - Response: errcode/errmsg; errcode===0 can still carry `invaliduser` (partial per-recipient
 *    failure inside an overall-successful call) + msgid.
 *  - Error codes this adapter reacts to: 42001 token expired / 40014 token invalid / 45009 rate
 *    limited / 45033 concurrency limited / 41001 missing token / 40056 invalid agentid / 60020
 *    IP not trusted / 40003 invalid UserID / 81013 all recipients invalid or unauthorized / 82001
 *    all recipients empty.
 */

export interface WeComMessageConfig {
  corpId: string
  corpSecret: string
  agentId: string
  baseUrl?: string
}

export class WeComRequestError extends Error {
  statusCode: number
  responseBody: Record<string, unknown> | null

  constructor(message: string, statusCode: number, responseBody: Record<string, unknown> | null) {
    super(message)
    this.name = 'WeComRequestError'
    this.statusCode = statusCode
    this.responseBody = responseBody
  }
}

export class WeComBusinessError extends Error {
  errcode: number
  responseBody: Record<string, unknown> | null

  constructor(message: string, errcode: number, responseBody: Record<string, unknown> | null) {
    super(message)
    this.name = 'WeComBusinessError'
    this.errcode = errcode
    this.responseBody = responseBody
  }
}

export class WeComTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`WeCom request timed out after ${timeoutMs}ms`)
    this.name = 'WeComTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** Credentials the token endpoint needs; a full {@link WeComMessageConfig} satisfies it. */
export interface WeComTokenConfig {
  corpId: string
  corpSecret: string
  baseUrl?: string
}

export interface WeComRequestOptions {
  fetchFn?: typeof fetch
  timeoutMs?: number
  /** Time seams for the read layer; the defaults are the real timer, `Math.random` and `Date.now`. */
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
}

export const WECOM_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.WECOM_REQUEST_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 10_000
})()

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function normalizeWeComBaseUrl(baseUrl?: string): string {
  const normalized = typeof baseUrl === 'string' && baseUrl.trim().length > 0
    ? baseUrl.trim()
    : 'https://qyapi.weixin.qq.com'
  return normalized.replace(/\/+$/, '')
}

function normalizeErrorMessage(payload: Record<string, unknown> | null, fallback: string): string {
  if (!payload) return fallback
  const candidate = payload.errmsg
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : fallback
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const payload = await response.json()
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  } catch {
    return null
  }
}

function readErrcode(payload: Record<string, unknown> | null): number | null {
  const raw = payload?.errcode
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string' && raw.trim().length > 0 && !Number.isNaN(Number(raw))) return Number(raw)
  return null
}

/**
 * The single WeCom HTTP call site. `strict` selects the read-layer behaviour (opt-in per call): the
 * request fails typed without provider text, URL or credentials, and a response that is not a JSON
 * object is an incomplete response. Without it the request path is the original one.
 */
async function requestWeComJson(
  path: string,
  init: RequestInit,
  fallbackError: string,
  baseUrl: string | undefined,
  options?: WeComRequestOptions,
  strict = false,
): Promise<Record<string, unknown>> {
  const timeoutMs = options?.timeoutMs ?? WECOM_REQUEST_TIMEOUT_MS
  const url = `${normalizeWeComBaseUrl(baseUrl)}${path}`
  let response: Response
  try {
    response = await (options?.fetchFn ?? fetch)(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (isAbortError(error)) {
      logger.warn(strict ? `WeCom read request timed out after ${timeoutMs}ms` : `WeCom request timed out after ${timeoutMs}ms`)
      throw new WeComTimeoutError(timeoutMs)
    }
    if (strict) {
      logger.warn('WeCom read request failed before a response')
      throw new WeComTransportError()
    }
    throw error
  }
  if (strict) return readStrictWeComPayload(response, timeoutMs)
  const payload = await readJson(response)

  if (!response.ok) {
    const message = normalizeErrorMessage(payload, fallbackError)
    logger.warn(`WeCom request failed (${response.status}): ${message}`)
    throw new WeComRequestError(message, response.status, payload)
  }

  const errcode = readErrcode(payload)
  if (errcode !== null && errcode !== 0) {
    throw new WeComBusinessError(normalizeErrorMessage(payload, fallbackError), errcode, payload)
  }

  return payload ?? {}
}

/** Read-layer response handling: a body that fails mid-read is a timeout or a transport fault, never an empty body. */
async function readStrictWeComPayload(response: Response, timeoutMs: number): Promise<Record<string, unknown>> {
  if (!response.ok) {
    logger.warn(`WeCom read request answered HTTP ${response.status}`)
    try {
      await response.body?.cancel()
    } catch {
      // the status alone decides the outcome
    }
    throw new WeComRequestError(WECOM_READ_REQUEST_FAILURE_MESSAGE, response.status, null)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    if (isAbortError(error)) {
      logger.warn(`WeCom read response timed out after ${timeoutMs}ms`)
      throw new WeComTimeoutError(timeoutMs)
    }
    if (error instanceof SyntaxError) throw new WeComIncompleteResponseError('response')
    logger.warn('WeCom read response could not be read')
    throw new WeComTransportError()
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new WeComIncompleteResponseError('response')
  }
  const record = payload as Record<string, unknown>
  const errcode = readErrcode(record)
  if (errcode !== null && errcode !== 0) {
    logger.warn(`WeCom read request rejected (errcode ${errcode})`)
    throw new WeComBusinessError(WECOM_READ_BUSINESS_FAILURE_MESSAGE, errcode, null)
  }
  return record
}

// ── App access-token cache ──────────────────────────────────────────────────
// Independent cache from the DingTalk client (design-lock G3: "勿复用 DingTalk 缓存") — different
// provider, different token lifecycle, different secret rotation cadence. Keyed by
// corpid|baseUrl|credential fingerprint, so an app token is never served for another app's secret.
// TTL = expires_in - 120s margin (WeCom's own guidance: tokens "可能提前失效，应实现失效重取"), failures
// are never cached, concurrent callers share one in-flight request.
const WECOM_TOKEN_EXPIRY_MARGIN_MS = 120 * 1000
const WECOM_TOKEN_FALLBACK_TTL_MS = 3300 * 1000
const wecomTokenCache = new Map<string, { token: string; expiresAt: number }>()
type WeComTokenLayer = 'single' | 'read'
const wecomTokenInFlight = new Map<string, { layer: WeComTokenLayer; promise: Promise<string> }>()

function wecomTokenTtlMs(expiresInSeconds: number | null): number {
  return expiresInSeconds !== null
    ? Math.max(expiresInSeconds * 1000 - WECOM_TOKEN_EXPIRY_MARGIN_MS, 30 * 1000)
    : WECOM_TOKEN_FALLBACK_TTL_MS
}

/** First 16 hex characters of the secret's SHA-256: in-memory only, never logged or thrown. */
function wecomSecretFingerprint(corpSecret: string): string {
  return createHash('sha256').update(corpSecret).digest('hex').slice(0, 16)
}

function wecomTokenCacheKey(config: WeComTokenConfig | WeComMessageConfig): string {
  return `${config.corpId}|${normalizeWeComBaseUrl(config.baseUrl)}|${wecomSecretFingerprint(config.corpSecret)}`
}

export function invalidateWeComAppAccessTokenCache(config?: WeComTokenConfig | WeComMessageConfig): void {
  if (config) wecomTokenCache.delete(wecomTokenCacheKey(config))
  else wecomTokenCache.clear()
}

export function __resetWeComAppAccessTokenCacheForTests(): void {
  wecomTokenCache.clear()
  wecomTokenInFlight.clear()
}

async function fetchWeComAppAccessTokenUncached(
  config: WeComTokenConfig | WeComMessageConfig,
  options?: WeComRequestOptions,
): Promise<{ token: string; expiresInSeconds: number | null }> {
  const payload = await requestWeComJson(
    `/cgi-bin/gettoken?corpid=${encodeURIComponent(config.corpId)}&corpsecret=${encodeURIComponent(config.corpSecret)}`,
    { method: 'GET', headers: { Accept: 'application/json' } },
    'Failed to obtain WeCom access token',
    config.baseUrl,
    options,
  )

  const token = typeof payload.access_token === 'string' ? payload.access_token : ''
  if (!token) {
    throw new Error(normalizeErrorMessage(payload, 'Failed to obtain WeCom access token'))
  }

  const expiresRaw = Number(payload.expires_in)
  return { token, expiresInSeconds: Number.isFinite(expiresRaw) && expiresRaw > 0 ? expiresRaw : null }
}

/** Exposed for tests: the cache key never contains the secret itself. */
export function __weComTokenCacheKeyForTests(config: WeComTokenConfig | WeComMessageConfig): string {
  return wecomTokenCacheKey(config)
}

/**
 * The one token cache and in-flight registry. Callers of the same layer under one key share a single
 * request. A caller of the other layer waits for it to settle and then uses the cached token, or makes
 * its own request, so each layer keeps its own error shape and time budget.
 */
async function obtainCachedWeComToken(
  config: WeComTokenConfig | WeComMessageConfig,
  layer: WeComTokenLayer,
  fetchToken: () => Promise<{ token: string; expiresInSeconds: number | null }>,
): Promise<string> {
  const key = wecomTokenCacheKey(config)
  for (;;) {
    const cached = wecomTokenCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.token
    wecomTokenCache.delete(key)
    const flight = wecomTokenInFlight.get(key)
    if (!flight) break
    if (layer === 'single' && flight.layer === 'single') return flight.promise
    await flight.promise.then(() => undefined, () => undefined)
  }

  const request = (async () => {
    const { token, expiresInSeconds } = await fetchToken()
    wecomTokenCache.set(key, { token, expiresAt: Date.now() + wecomTokenTtlMs(expiresInSeconds) })
    return token
  })()
  const entry = { layer, promise: request }
  wecomTokenInFlight.set(key, entry)
  try {
    return await request
  } finally {
    if (wecomTokenInFlight.get(key) === entry) wecomTokenInFlight.delete(key)
  }
}

export async function fetchWeComAppAccessToken(
  config: WeComTokenConfig | WeComMessageConfig,
  options?: WeComRequestOptions,
): Promise<string> {
  return obtainCachedWeComToken(config, 'single', () => fetchWeComAppAccessTokenUncached(config, options))
}

// ── Config (env-only; G7 scopes DB/directory-stored WeCom app config out of S4) ────────────────
// The factory gate (createAttendanceDeliveryChannelsFromEnv) must be able to check readiness
// SYNCHRONOUSLY (mirrors resolveEmailTransportReadiness), which rules out a DB-backed tier here —
// that tier (and any settings UI to populate it) is a named follow-up, not this slice.

function readStringEnv(env: NodeJS.ProcessEnv, ...keys: string[]): string {
  for (const key of keys) {
    const value = env[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

export function readWeComMessageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WeComMessageConfig {
  const corpId = readStringEnv(env, 'WECOM_CORP_ID')
  const corpSecret = readStringEnv(env, 'WECOM_CORP_SECRET')
  const agentId = readStringEnv(env, 'WECOM_AGENT_ID')
  const baseUrl = readStringEnv(env, 'WECOM_BASE_URL') || undefined

  if (!corpId) throw new Error('WECOM_CORP_ID is not configured')
  if (!corpSecret) throw new Error('WECOM_CORP_SECRET is not configured')
  if (!agentId) throw new Error('WECOM_AGENT_ID is not configured')

  return { corpId, corpSecret, agentId, baseUrl }
}

export function resolveWeComMessageConfigReadiness(
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; config: WeComMessageConfig | null } {
  try {
    return { ok: true, config: readWeComMessageConfigFromEnv(env) }
  } catch {
    return { ok: false, config: null }
  }
}

// ── Field-length guards (design-lock G4) ────────────────────────────────────────────────────────
// textcard.title/description are character-counted ("字"); textcard.url and text.content are
// byte-counted ("字节", UTF-8). Exported so the delivery channel (DI-testable) can clamp BEFORE
// calling the (possibly-stubbed-in-tests) send function — clamping inside the send function itself
// would be invisible to a DI-mode unit test that stubs the sender.
export const WECOM_TEXTCARD_TITLE_MAX_CHARS = 128
export const WECOM_TEXTCARD_DESCRIPTION_MAX_CHARS = 512
export const WECOM_TEXT_CONTENT_MAX_BYTES = 2048

export function clampWeComCharLength(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value
}

export function clampWeComByteLengthUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let end = value.length
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) {
    end -= 1
  }
  return value.slice(0, end)
}

// ── Send ─────────────────────────────────────────────────────────────────────────────────────────

export interface WeComTextMessageInput {
  userIds: string[]
  content: string
}

export interface WeComTextCardMessageInput {
  userIds: string[]
  title: string
  description: string
  url: string
  btnTxt: string
}

export interface WeComSendMessageResult {
  errcode: number
  errmsg: string
  msgId?: string
  invalidUserIds: string[]
  raw: Record<string, unknown>
}

function parsePipeList(value: unknown): string[] {
  return typeof value === 'string'
    ? value.split('|').map((item) => item.trim()).filter(Boolean)
    : []
}

function toWeComResult(payload: Record<string, unknown>): WeComSendMessageResult {
  const errcodeRaw = payload.errcode
  const errcode = typeof errcodeRaw === 'number' ? errcodeRaw : 0
  const errmsg = typeof payload.errmsg === 'string' ? payload.errmsg : 'ok'
  const msgIdValue = payload.msgid
  return {
    errcode,
    errmsg,
    msgId: typeof msgIdValue === 'string' ? msgIdValue : undefined,
    invalidUserIds: parsePipeList(payload.invaliduser),
    raw: payload,
  }
}

function normalizeUserIds(userIds: string[]): string[] {
  return Array.from(new Set(userIds.map((userId) => String(userId ?? '').trim()).filter(Boolean)))
}

function agentIdForPayload(agentId: string): string | number {
  return Number.isNaN(Number(agentId)) ? agentId : Number(agentId)
}

export async function sendWeComTextMessage(
  accessToken: string,
  input: WeComTextMessageInput,
  config: WeComMessageConfig,
  options?: WeComRequestOptions,
): Promise<WeComSendMessageResult> {
  const userIds = normalizeUserIds(input.userIds)
  const content = input.content.trim()
  if (userIds.length === 0) throw new Error('At least one WeCom userId is required')
  if (!content) throw new Error('WeCom text content is required')

  const payload = await requestWeComJson(
    `/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: userIds.join('|'),
        agentid: agentIdForPayload(config.agentId),
        msgtype: 'text',
        text: { content },
      }),
    },
    'Failed to send WeCom text work notification',
    config.baseUrl,
    options,
  )

  return toWeComResult(payload)
}

export async function sendWeComTextCardMessage(
  accessToken: string,
  input: WeComTextCardMessageInput,
  config: WeComMessageConfig,
  options?: WeComRequestOptions,
): Promise<WeComSendMessageResult> {
  const userIds = normalizeUserIds(input.userIds)
  const title = input.title.trim()
  const description = input.description.trim()
  const url = input.url.trim()
  const btnTxt = input.btnTxt.trim()
  if (userIds.length === 0) throw new Error('At least one WeCom userId is required')
  if (!title) throw new Error('WeCom textcard title is required')
  if (!description) throw new Error('WeCom textcard description is required')
  if (!url) throw new Error('WeCom textcard url is required')
  if (!btnTxt) throw new Error('WeCom textcard btntxt is required')

  const payload = await requestWeComJson(
    `/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: userIds.join('|'),
        agentid: agentIdForPayload(config.agentId),
        msgtype: 'textcard',
        textcard: { title, description, url, btntxt: btnTxt },
      }),
    },
    'Failed to send WeCom textcard work notification',
    config.baseUrl,
    options,
  )

  return toWeComResult(payload)
}

// ── Read layer: contacts and app-detail calls ────────────────────────────────────────────────────
// Opt-in per call: only the functions below route through it, so the request path above (token
// fetch for legacy callers, the two send functions) is unchanged. A read call is idempotent (GET),
// retries only the transient set, shares one total time budget, and never lets provider text
// (`errmsg`, the response body, the URL, the token) reach a thrown error, a log line or a snapshot.

/** One client call (token fetch + attempts + at most one refetch) shares this budget. */
export const WECOM_READ_CALL_DEADLINE_MS = 12_000
/** Attempts per request, first included. */
export const WECOM_READ_MAX_ATTEMPTS = 3
const WECOM_READ_BACKOFF_BASE_MS = 250
const WECOM_READ_BACKOFF_CAP_MS = 2_000
/** The only business codes a read call retries (45009 is a rate limit and is never retried). */
const WECOM_READ_RETRIED_ERRCODES: ReadonlySet<number> = new Set<number>([45033, -1])
const WECOM_TOKEN_STALE_ERRCODES: ReadonlySet<number> = new Set<number>([42001, 40014])

const WECOM_READ_BUSINESS_FAILURE_MESSAGE = 'WeCom API returned an error code'
const WECOM_READ_REQUEST_FAILURE_MESSAGE = 'WeCom API answered with an error status'

/** Where a response failed its closed shape; never carries content. */
export type WeComIncompleteLocation =
  | 'response'
  | 'token'
  | 'agent'
  | 'agent_scope'
  | 'department_list'
  | 'department'
  | 'department_graph'
  | 'user_list'
  | 'user'

export class WeComIncompleteResponseError extends Error {
  readonly location: WeComIncompleteLocation

  constructor(location: WeComIncompleteLocation) {
    super('WeCom response was incomplete')
    this.name = 'WeComIncompleteResponseError'
    this.location = location
  }
}

/** A request that produced no HTTP response and was not a timeout. */
export class WeComTransportError extends Error {
  constructor() {
    super('WeCom request could not be completed')
    this.name = 'WeComTransportError'
  }
}

export type WeComInvalidInputField = 'corpId' | 'corpSecret' | 'wecomAgentId' | 'departmentId' | 'userid'

/** An input rejected before any request was issued. */
export class WeComInvalidInputError extends Error {
  readonly field: WeComInvalidInputField

  constructor(field: WeComInvalidInputField) {
    super('WeCom request input is invalid')
    this.name = 'WeComInvalidInputError'
    this.field = field
  }
}

// Input validators (checked before any request; query values are also percent-encoded).
const WECOM_CORP_ID_PATTERN = /^[\x21-\x7e]{1,64}$/
const WECOM_AGENT_ID_PATTERN = /^[1-9]\d{0,14}$/
const WECOM_USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,63}$/
const WECOM_DEPARTMENT_ID_PATTERN = /^\d{1,10}$/

export function isValidWeComCorpId(value: unknown): boolean {
  return typeof value === 'string' && WECOM_CORP_ID_PATTERN.test(value)
}

export function isValidWeComAgentId(value: unknown): boolean {
  return typeof value === 'string' && WECOM_AGENT_ID_PATTERN.test(value)
}

/** The member-creation rule: 1-64 bytes, letters digits and `_-@.`, first character a letter or digit. */
export function isValidWeComUserId(value: unknown): boolean {
  return typeof value === 'string' && WECOM_USER_ID_PATTERN.test(value)
}

export function isValidWeComDepartmentId(value: unknown): boolean {
  return typeof value === 'string' && WECOM_DEPARTMENT_ID_PATTERN.test(value)
}

/** Deployment-level base URL (the only place a base URL comes from); read at call time. */
export function readWeComBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = readStringEnv(env, 'WECOM_BASE_URL')
  return value || undefined
}

// Single errcode mapping shared by the retry logic and its consumers.
export type WeComErrorCategory =
  | 'token_stale'
  | 'config_fault'
  | 'permission_fault'
  | 'scope_fault'
  | 'rate_limited'
  | 'busy'
  | 'subject_invalid'
  | 'code_invalid'
  | 'recipient_invalid'
  | 'other'

export function classifyWeComErrcode(errcode: number): WeComErrorCategory {
  if (WECOM_TOKEN_STALE_ERRCODES.has(errcode)) return 'token_stale'
  if (WECOM_READ_RETRIED_ERRCODES.has(errcode)) return 'busy'
  if (errcode === 45009) return 'rate_limited'
  switch (errcode) {
    case 40013:
    case 40056:
    case 41001:
    case 301002:
    case 60020:
    case 50001:
      return 'config_fault'
    case 48001:
    case 48002:
      return 'permission_fault'
    case 50002:
    case 60011:
    case 60123:
      return 'scope_fault'
    case 40003:
    case 60111:
    case 46004:
      return 'subject_invalid'
    case 40029:
      return 'code_invalid'
    case 81013:
    case 82001:
      return 'recipient_invalid'
    default:
      return 'other'
  }
}

// Retry observation: synchronous observers only; a throwing observer is swallowed.
export interface WeComTransportRetryEvent {
  reason: string
}
export type WeComTransportRetryObserver = (event: WeComTransportRetryEvent) => void

const wecomRetryObserverStorage = new AsyncLocalStorage<WeComTransportRetryObserver>()

/** Runs `fn` with `observer` receiving every read-layer retry made inside its async context. */
export function observeWeComTransportRetries<T>(
  observer: WeComTransportRetryObserver,
  fn: () => Promise<T>,
): Promise<T> {
  return wecomRetryObserverStorage.run(observer, fn)
}

interface WeComReadContext {
  fetchFn: typeof fetch | undefined
  timeoutMs: number
  deadlineAt: number
  now: () => number
  sleep: (ms: number) => Promise<void>
  random: () => number
}

function createWeComReadContext(options?: WeComRequestOptions): WeComReadContext {
  const now = options?.now ?? Date.now
  return {
    fetchFn: options?.fetchFn,
    timeoutMs: options?.timeoutMs ?? WECOM_REQUEST_TIMEOUT_MS,
    deadlineAt: now() + WECOM_READ_CALL_DEADLINE_MS,
    now,
    sleep: options?.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    random: options?.random ?? Math.random,
  }
}

async function readWeComReadAttempt(
  path: string,
  baseUrl: string | undefined,
  ctx: WeComReadContext,
  remainingMs: number,
): Promise<Record<string, unknown>> {
  const timeoutMs = Math.max(1, Math.floor(Math.min(ctx.timeoutMs, remainingMs)))
  return requestWeComJson(
    path,
    { method: 'GET', headers: { Accept: 'application/json' } },
    WECOM_READ_REQUEST_FAILURE_MESSAGE,
    baseUrl,
    { fetchFn: ctx.fetchFn, timeoutMs },
    true,
  )
}

function weComRetryReason(error: unknown): string | null {
  if (error instanceof WeComBusinessError) {
    return classifyWeComErrcode(error.errcode) === 'busy' ? `flow_control_errcode_${error.errcode}` : null
  }
  if (error instanceof WeComRequestError) return error.statusCode >= 500 ? 'http_5xx' : null
  if (error instanceof WeComTransportError || error instanceof WeComTimeoutError) return 'network_error'
  return null
}

async function readWeComJson(
  path: string,
  baseUrl: string | undefined,
  ctx: WeComReadContext,
): Promise<Record<string, unknown>> {
  for (let attempt = 1; ; attempt += 1) {
    const remainingMs = ctx.deadlineAt - ctx.now()
    if (remainingMs <= 0) throw new WeComTimeoutError(WECOM_READ_CALL_DEADLINE_MS)
    try {
      return await readWeComReadAttempt(path, baseUrl, ctx, remainingMs)
    } catch (error) {
      const reason = weComRetryReason(error)
      if (reason === null || attempt >= WECOM_READ_MAX_ATTEMPTS) throw error
      const ceilingMs = Math.min(WECOM_READ_BACKOFF_CAP_MS, WECOM_READ_BACKOFF_BASE_MS * 2 ** (attempt - 1))
      const delayMs = Math.floor(ctx.random() * ceilingMs)
      if (delayMs >= ctx.deadlineAt - ctx.now()) throw new WeComTimeoutError(WECOM_READ_CALL_DEADLINE_MS)
      logger.warn(`WeCom read retry ${attempt + 1}/${WECOM_READ_MAX_ATTEMPTS} after ${reason}`)
      const observer = wecomRetryObserverStorage.getStore()
      if (observer) {
        try {
          observer({ reason })
        } catch {
          // observation only: it can never change a retry decision or the error shape
        }
      }
      await ctx.sleep(delayMs)
    }
  }
}

async function readWeComAccessToken(config: WeComTokenConfig, ctx: WeComReadContext): Promise<string> {
  return obtainCachedWeComToken(config, 'read', async () => {
    const payload = await readWeComJson(
      `/cgi-bin/gettoken?corpid=${encodeURIComponent(config.corpId)}&corpsecret=${encodeURIComponent(config.corpSecret)}`,
      config.baseUrl,
      ctx,
    )
    const token = typeof payload.access_token === 'string' ? payload.access_token : ''
    if (!token) throw new WeComIncompleteResponseError('token')
    const expiresRaw = Number(payload.expires_in)
    return { token, expiresInSeconds: Number.isFinite(expiresRaw) && expiresRaw > 0 ? expiresRaw : null }
  })
}

function assertWeComReadCredentials(config: WeComTokenConfig): void {
  if (!isValidWeComCorpId(config.corpId)) throw new WeComInvalidInputError('corpId')
  if (typeof config.corpSecret !== 'string' || config.corpSecret.length === 0) {
    throw new WeComInvalidInputError('corpSecret')
  }
}

/**
 * One client call: token, the operation, and (on a stale token) exactly one invalidate-and-refetch,
 * all inside one time budget.
 */
async function runWeComReadCall<T>(
  config: WeComTokenConfig,
  options: WeComRequestOptions | undefined,
  operation: (accessToken: string, ctx: WeComReadContext) => Promise<T>,
): Promise<T> {
  const ctx = createWeComReadContext(options)
  const first = await readWeComAccessToken(config, ctx)
  try {
    return await operation(first, ctx)
  } catch (error) {
    if (!(error instanceof WeComBusinessError) || classifyWeComErrcode(error.errcode) !== 'token_stale') throw error
    invalidateWeComAppAccessTokenCache(config)
    return operation(await readWeComAccessToken(config, ctx), ctx)
  }
}

// ── Closed-shape parsers ─────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isAbsent(value: unknown): value is undefined | null {
  return value === undefined || value === null
}

function readIntArray(value: unknown, location: WeComIncompleteLocation): number[] {
  if (!Array.isArray(value)) throw new WeComIncompleteResponseError(location)
  return value.map((item) => {
    if (!isSafeInt(item) || item < 0) throw new WeComIncompleteResponseError(location)
    return item
  })
}

export interface WeComAgentDetail {
  /** Decimal string of the integer `agentid`. */
  agentId: string
  closed: boolean
  redirectDomain: string | null
  /** Key presence, not truthiness (a value of 0 still counts). */
  hasCustomizedPublishStatus: boolean
  allowUserIds: string[]
  allowPartyIds: number[]
  allowTagIds: number[]
}

function parseAgentResponse(payload: Record<string, unknown>): WeComAgentDetail {
  if (!isSafeInt(payload.agentid) || payload.agentid < 1) throw new WeComIncompleteResponseError('agent')
  if (!Number.isInteger(payload.close)) throw new WeComIncompleteResponseError('agent')
  const redirect = payload.redirect_domain
  if (!isAbsent(redirect) && typeof redirect !== 'string') throw new WeComIncompleteResponseError('agent')

  const userinfos = payload.allow_userinfos
  const partys = payload.allow_partys
  const tags = payload.allow_tags
  if (!isRecord(userinfos) || !Array.isArray(userinfos.user)) throw new WeComIncompleteResponseError('agent_scope')
  if (!isRecord(partys)) throw new WeComIncompleteResponseError('agent_scope')
  if (!isRecord(tags)) throw new WeComIncompleteResponseError('agent_scope')
  const allowUserIds = userinfos.user.map((entry) => {
    if (!isRecord(entry) || typeof entry.userid !== 'string') throw new WeComIncompleteResponseError('agent_scope')
    return entry.userid
  })

  return {
    agentId: String(payload.agentid),
    closed: payload.close !== 0,
    redirectDomain: typeof redirect === 'string' ? redirect : null,
    hasCustomizedPublishStatus: Object.prototype.hasOwnProperty.call(payload, 'customized_publish_status'),
    allowUserIds,
    allowPartyIds: readIntArray(partys.partyid, 'agent_scope'),
    allowTagIds: readIntArray(tags.tagid, 'agent_scope'),
  }
}

export interface WeComDepartmentEntry {
  id: number
  name: string
  parentId: number
  order?: number
  nameEn?: string
  departmentLeader?: string[]
}

function parseDepartmentListResponse(payload: Record<string, unknown>): WeComDepartmentEntry[] {
  const list = payload.department
  if (!Array.isArray(list)) throw new WeComIncompleteResponseError('department_list')
  return list.map((item) => {
    if (!isRecord(item)) throw new WeComIncompleteResponseError('department')
    if (!isSafeInt(item.id) || item.id < 1 || !isValidWeComDepartmentId(String(item.id))) {
      throw new WeComIncompleteResponseError('department')
    }
    if (typeof item.name !== 'string') throw new WeComIncompleteResponseError('department')
    if (!isSafeInt(item.parentid) || item.parentid < 0 || !isValidWeComDepartmentId(String(item.parentid))) {
      throw new WeComIncompleteResponseError('department')
    }
    const entry: WeComDepartmentEntry = { id: item.id, name: item.name, parentId: item.parentid }
    if (!isAbsent(item.order)) {
      if (!isSafeInt(item.order)) throw new WeComIncompleteResponseError('department')
      entry.order = item.order
    }
    if (!isAbsent(item.name_en)) {
      if (typeof item.name_en !== 'string') throw new WeComIncompleteResponseError('department')
      entry.nameEn = item.name_en
    }
    if (!isAbsent(item.department_leader)) {
      if (!Array.isArray(item.department_leader) || !item.department_leader.every((v) => typeof v === 'string')) {
        throw new WeComIncompleteResponseError('department')
      }
      entry.departmentLeader = [...item.department_leader] as string[]
    }
    return entry
  })
}

export interface WeComDirectoryMemberEntry {
  /** As returned: the adapter applies the member-id rules. */
  userid: string
  name?: string
  position?: string
  avatar?: string
  mobile?: string
  email?: string
  department?: number[]
  mainDepartment?: number
  status?: number
  order?: number | number[]
  isLeaderInDept?: number | number[]
  directLeader?: string | string[]
}

function readOptionalString(value: unknown): string | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'string') throw new WeComIncompleteResponseError('user')
  return value
}

/** A pass-through value is absent, a number, or an array of numbers; any other present value is a shape fault. */
function readPassThroughNumbers(value: unknown): number | number[] | undefined {
  if (isAbsent(value)) return undefined
  if (isSafeInt(value)) return value
  if (Array.isArray(value) && value.every(isSafeInt)) return [...value] as number[]
  throw new WeComIncompleteResponseError('user')
}

/** A pass-through value is absent, a string, or an array of strings; any other present value is a shape fault. */
function readPassThroughStrings(value: unknown): string | string[] | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return [...value] as string[]
  throw new WeComIncompleteResponseError('user')
}

function parseUserListResponse(payload: Record<string, unknown>): WeComDirectoryMemberEntry[] {
  const list = payload.userlist
  if (!Array.isArray(list)) throw new WeComIncompleteResponseError('user_list')
  return list.map((item) => {
    if (!isRecord(item) || typeof item.userid !== 'string') throw new WeComIncompleteResponseError('user')
    const member: WeComDirectoryMemberEntry = { userid: item.userid }
    const name = readOptionalString(item.name)
    if (name !== undefined) member.name = name
    const position = readOptionalString(item.position)
    if (position !== undefined) member.position = position
    const avatar = readOptionalString(item.avatar)
    if (avatar !== undefined) member.avatar = avatar
    const mobile = readOptionalString(item.mobile)
    if (mobile !== undefined) member.mobile = mobile
    const email = readOptionalString(item.email)
    if (email !== undefined) member.email = email
    if (!isAbsent(item.department)) member.department = readIntArray(item.department, 'user')
    if (!isAbsent(item.main_department)) {
      if (!isSafeInt(item.main_department) || item.main_department < 0) throw new WeComIncompleteResponseError('user')
      member.mainDepartment = item.main_department
    }
    if (!isAbsent(item.status)) {
      if (!isSafeInt(item.status)) throw new WeComIncompleteResponseError('user')
      member.status = item.status
    }
    const order = readPassThroughNumbers(item.order)
    if (order !== undefined) member.order = order
    const leaderFlags = readPassThroughNumbers(item.is_leader_in_dept)
    if (leaderFlags !== undefined) member.isLeaderInDept = leaderFlags
    const directLeader = readPassThroughStrings(item.direct_leader)
    if (directLeader !== undefined) member.directLeader = directLeader
    return member
  })
}

// ── Read calls ───────────────────────────────────────────────────────────────────────────────────

/** `GET /cgi-bin/agent/get` — the whitelisted fields of the app behind `config`. */
export async function getWeComAgent(
  config: WeComTokenConfig,
  wecomAgentId: string,
  options?: WeComRequestOptions,
): Promise<WeComAgentDetail> {
  assertWeComReadCredentials(config)
  if (!isValidWeComAgentId(wecomAgentId)) throw new WeComInvalidInputError('wecomAgentId')
  return runWeComReadCall(config, options, async (accessToken, ctx) => {
    const payload = await readWeComJson(
      `/cgi-bin/agent/get?access_token=${encodeURIComponent(accessToken)}&agentid=${encodeURIComponent(wecomAgentId)}`,
      config.baseUrl,
      ctx,
    )
    return parseAgentResponse(payload)
  })
}

/** `GET /cgi-bin/department/list` without `id`: every department visible to the app. */
export async function listWeComDepartments(
  config: WeComTokenConfig,
  options?: WeComRequestOptions,
): Promise<WeComDepartmentEntry[]> {
  assertWeComReadCredentials(config)
  return runWeComReadCall(config, options, async (accessToken, ctx) => {
    const payload = await readWeComJson(
      `/cgi-bin/department/list?access_token=${encodeURIComponent(accessToken)}`,
      config.baseUrl,
      ctx,
    )
    return parseDepartmentListResponse(payload)
  })
}

/** `GET /cgi-bin/user/list?department_id=` — the members of one department, fields whitelisted. */
export async function listWeComDepartmentMembers(
  config: WeComTokenConfig,
  departmentId: string,
  options?: WeComRequestOptions,
): Promise<WeComDirectoryMemberEntry[]> {
  assertWeComReadCredentials(config)
  if (!isValidWeComDepartmentId(departmentId)) throw new WeComInvalidInputError('departmentId')
  return runWeComReadCall(config, options, async (accessToken, ctx) => {
    const payload = await readWeComJson(
      `/cgi-bin/user/list?access_token=${encodeURIComponent(accessToken)}&department_id=${encodeURIComponent(departmentId)}`,
      config.baseUrl,
      ctx,
    )
    return parseUserListResponse(payload)
  })
}
