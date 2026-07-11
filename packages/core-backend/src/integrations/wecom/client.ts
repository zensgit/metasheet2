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

interface WeComRequestOptions {
  fetchFn?: typeof fetch
  timeoutMs?: number
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

async function requestWeComJson(
  path: string,
  init: RequestInit,
  fallbackError: string,
  baseUrl: string | undefined,
  options?: WeComRequestOptions,
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
      logger.warn(`WeCom request timed out after ${timeoutMs}ms`)
      throw new WeComTimeoutError(timeoutMs)
    }
    throw error
  }
  const payload = await readJson(response)

  if (!response.ok) {
    const message = normalizeErrorMessage(payload, fallbackError)
    logger.warn(`WeCom request failed (${response.status}): ${message}`)
    throw new WeComRequestError(message, response.status, payload)
  }

  const errcodeRaw = payload?.errcode
  const errcode = typeof errcodeRaw === 'number'
    ? errcodeRaw
    : typeof errcodeRaw === 'string' && errcodeRaw.trim().length > 0 && !Number.isNaN(Number(errcodeRaw))
      ? Number(errcodeRaw)
      : null
  if (errcode !== null && errcode !== 0) {
    throw new WeComBusinessError(normalizeErrorMessage(payload, fallbackError), errcode, payload)
  }

  return payload ?? {}
}

// ── App access-token cache ──────────────────────────────────────────────────
// Independent cache from the DingTalk client (design-lock G3: "勿复用 DingTalk 缓存") — different
// provider, different token lifecycle, different secret rotation cadence. Keyed by corpid|baseUrl.
// TTL = expires_in - 120s margin (WeCom's own guidance: tokens "可能提前失效，应实现失效重取"), failures
// are never cached, concurrent callers share one in-flight request.
const WECOM_TOKEN_EXPIRY_MARGIN_MS = 120 * 1000
const WECOM_TOKEN_FALLBACK_TTL_MS = 3300 * 1000
const wecomTokenCache = new Map<string, { token: string; expiresAt: number }>()
const wecomTokenInFlight = new Map<string, Promise<string>>()

function wecomTokenCacheKey(config: WeComMessageConfig): string {
  return `${config.corpId}|${normalizeWeComBaseUrl(config.baseUrl)}`
}

export function invalidateWeComAppAccessTokenCache(config?: WeComMessageConfig): void {
  if (config) wecomTokenCache.delete(wecomTokenCacheKey(config))
  else wecomTokenCache.clear()
}

export function __resetWeComAppAccessTokenCacheForTests(): void {
  wecomTokenCache.clear()
  wecomTokenInFlight.clear()
}

async function fetchWeComAppAccessTokenUncached(
  config: WeComMessageConfig,
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

export async function fetchWeComAppAccessToken(
  config: WeComMessageConfig,
  options?: WeComRequestOptions,
): Promise<string> {
  const key = wecomTokenCacheKey(config)
  const cached = wecomTokenCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token
  }
  wecomTokenCache.delete(key)

  const inFlight = wecomTokenInFlight.get(key)
  if (inFlight) return inFlight

  const request = (async () => {
    const { token, expiresInSeconds } = await fetchWeComAppAccessTokenUncached(config, options)
    const ttlMs = expiresInSeconds !== null
      ? Math.max(expiresInSeconds * 1000 - WECOM_TOKEN_EXPIRY_MARGIN_MS, 30 * 1000)
      : WECOM_TOKEN_FALLBACK_TTL_MS
    wecomTokenCache.set(key, { token, expiresAt: Date.now() + ttlMs })
    return token
  })()
  wecomTokenInFlight.set(key, request)
  try {
    return await request
  } finally {
    wecomTokenInFlight.delete(key)
  }
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
