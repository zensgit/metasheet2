import { assertDingTalkCorpAllowed } from './runtime-policy'
import {
  normalizeErrorMessage,
  readNumericField,
  requestDingTalkTransportJson,
  type DingTalkCallKind,
} from './transport'

// Error shapes and the H06 timeout knob moved to the unified transport (roadmap
// §7.2) — re-exported so existing callers keep importing them from this module.
// isDingTalkOutcomeUnknown lets ledger writers distinguish "maybe delivered"
// send failures (network/timeout/5xx) from definite rejections.
export {
  DINGTALK_REQUEST_TIMEOUT_MS,
  DingTalkBusinessError,
  DingTalkMalformedResponseError,
  DingTalkRequestError,
  DingTalkTimeoutError,
  isDingTalkOutcomeUnknown,
} from './transport'

export interface DingTalkOauthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  corpId: string | null
}

export interface DingTalkUserAccessToken {
  accessToken: string
  expireIn?: number
  refreshToken?: string
}

export interface DingTalkCurrentUserProfile {
  openId: string
  unionId: string
  nick: string
  email?: string
  mobile?: string
  avatarUrl?: string
}

export interface DingTalkDirectoryConfig {
  appKey: string
  appSecret: string
  baseUrl?: string
}

export interface DingTalkMessageConfig extends DingTalkDirectoryConfig {
  agentId: string
}

export interface DingTalkWorkNotificationRuntimeStatus {
  configured: boolean
  available: boolean
  unavailableReason: 'missing_app_key' | 'missing_app_secret' | 'missing_agent_id' | null
  requirements: {
    appKey: {
      configured: boolean
      selectedKey: string | null
    }
    appSecret: {
      configured: boolean
      selectedKey: string | null
    }
    agentId: {
      configured: boolean
      selectedKey: string | null
    }
    baseUrl: {
      configured: boolean
      selectedKey: string | null
    }
  }
}

export interface DingTalkWorkNotificationInput {
  userIds: string[]
  title: string
  content: string
}

export interface DingTalkWorkNotificationResult {
  taskId?: string
  requestId?: string
  raw: Record<string, unknown>
}

interface DingTalkRequestOptions {
  fetchFn?: typeof fetch
  /** Override the default per-request timeout (DT-HARDEN-06); applies PER ATTEMPT. */
  timeoutMs?: number
  /** Overall abort signal: cancels the in-flight attempt AND any retry backoff immediately. */
  signal?: AbortSignal
}

export interface DingTalkDepartment {
  id: string
  parentId: string | null
  name: string
  order: number
  source: Record<string, unknown>
  /**
   * Filled by the dept-head enrichment pass (department-detail fetch).
   * `undefined` = not fetched / fetch failed (carry prior forward); `[]` = success-empty.
   */
  managerUserIds?: string[]
}

export interface DingTalkDepartmentUserSummary {
  userId: string
  name: string
  unionId?: string
  mobile?: string
  email?: string
  title?: string
  avatarUrl?: string
  departmentIds: string[]
  source: Record<string, unknown>
}

export interface DingTalkDirectoryUser {
  userId: string
  name: string
  nick?: string
  unionId?: string
  openId?: string
  mobile?: string
  email?: string
  jobNumber?: string
  title?: string
  avatarUrl?: string
  departmentIds: string[]
  source: Record<string, unknown>
}

function readStringEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return ''
}

function readEnvStatus<const T extends readonly string[]>(
  keys: T,
): { configured: boolean; selectedKey: T[number] | null } {
  for (const key of keys) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return {
        configured: true,
        selectedKey: key,
      }
    }
  }
  return {
    configured: false,
    selectedKey: null,
  }
}

function readNestedPayload(payload: Record<string, unknown>, key = 'result'): Record<string, unknown> {
  const nested = payload[key]
  return nested && typeof nested === 'object' ? nested as Record<string, unknown> : {}
}

function normalizeDirectoryBaseUrl(baseUrl?: string): string {
  const normalized = typeof baseUrl === 'string' && baseUrl.trim().length > 0
    ? baseUrl.trim()
    : 'https://oapi.dingtalk.com'
  return normalized.replace(/\/+$/, '')
}

/**
 * v1.0 api.dingtalk.com endpoints (HTTP-status based, no errcode envelope). All
 * timeout/retry/backoff/flow-control handling lives in the shared transport seam
 * (roadmap §7.2); `kind` is the explicit business-semantics tier every call site
 * must declare (read / exchange / send) — see DingTalkCallKind in ./transport.
 */
async function requestDingTalkJson(
  input: string,
  init: RequestInit,
  fallbackError: string,
  kind: DingTalkCallKind,
  options?: DingTalkRequestOptions,
): Promise<Record<string, unknown>> {
  return requestDingTalkTransportJson({
    input,
    init,
    fallbackError,
    kind,
    envelope: 'none',
    fetchFn: options?.fetchFn,
    timeoutMs: options?.timeoutMs,
    signal: options?.signal,
  })
}

/**
 * Legacy oapi.dingtalk.com envelope endpoints: an `errcode !== 0` inside an HTTP-200
 * body surfaces as DingTalkBusinessError. The envelope is checked INSIDE the
 * transport's retry loop so flow-control errcodes back off on idempotent reads.
 */
async function requestDingTalkDirectoryJson(
  path: string,
  init: RequestInit,
  fallbackError: string,
  kind: DingTalkCallKind,
  baseUrl?: string,
  options?: DingTalkRequestOptions,
): Promise<Record<string, unknown>> {
  return requestDingTalkTransportJson({
    input: `${normalizeDirectoryBaseUrl(baseUrl)}${path}`,
    init,
    fallbackError,
    kind,
    envelope: 'oapi',
    fetchFn: options?.fetchFn,
    timeoutMs: options?.timeoutMs,
    signal: options?.signal,
  })
}

export function readDingTalkOauthConfig(): DingTalkOauthConfig {
  const clientId = readStringEnv('DINGTALK_CLIENT_ID', 'DINGTALK_APP_KEY')
  const clientSecret = readStringEnv('DINGTALK_CLIENT_SECRET', 'DINGTALK_APP_SECRET')
  const redirectUri = readStringEnv('DINGTALK_REDIRECT_URI')
  const corpId = readStringEnv('DINGTALK_CORP_ID') || null

  if (!clientId) throw new Error('DINGTALK_CLIENT_ID or DINGTALK_APP_KEY is not configured')
  if (!clientSecret) throw new Error('DINGTALK_CLIENT_SECRET or DINGTALK_APP_SECRET is not configured')
  if (!redirectUri) throw new Error('DINGTALK_REDIRECT_URI is not configured')
  assertDingTalkCorpAllowed(corpId, { allowEmpty: true, context: 'DINGTALK_CORP_ID' })

  return {
    clientId,
    clientSecret,
    redirectUri,
    corpId,
  }
}

export function readDingTalkMessageConfig(): DingTalkMessageConfig {
  const appKey = readStringEnv('DINGTALK_APP_KEY', 'DINGTALK_CLIENT_ID')
  const appSecret = readStringEnv('DINGTALK_APP_SECRET', 'DINGTALK_CLIENT_SECRET')
  const agentId = readStringEnv('DINGTALK_AGENT_ID', 'DINGTALK_NOTIFY_AGENT_ID')
  const baseUrl = readStringEnv('DINGTALK_BASE_URL') || undefined

  if (!appKey) throw new Error('DINGTALK_APP_KEY or DINGTALK_CLIENT_ID is not configured')
  if (!appSecret) throw new Error('DINGTALK_APP_SECRET or DINGTALK_CLIENT_SECRET is not configured')
  if (!agentId) throw new Error('DINGTALK_AGENT_ID or DINGTALK_NOTIFY_AGENT_ID is not configured')

  return {
    appKey,
    appSecret,
    agentId,
    baseUrl,
  }
}

export function getDingTalkWorkNotificationRuntimeStatus(): DingTalkWorkNotificationRuntimeStatus {
  const appKey = readEnvStatus(['DINGTALK_APP_KEY', 'DINGTALK_CLIENT_ID'] as const)
  const appSecret = readEnvStatus(['DINGTALK_APP_SECRET', 'DINGTALK_CLIENT_SECRET'] as const)
  const agentId = readEnvStatus(['DINGTALK_AGENT_ID', 'DINGTALK_NOTIFY_AGENT_ID'] as const)
  const baseUrl = readEnvStatus(['DINGTALK_BASE_URL'] as const)
  const unavailableReason = !appKey.configured
    ? 'missing_app_key'
    : !appSecret.configured
      ? 'missing_app_secret'
      : !agentId.configured
        ? 'missing_agent_id'
        : null

  return {
    configured: unavailableReason === null,
    available: unavailableReason === null,
    unavailableReason,
    requirements: {
      appKey,
      appSecret,
      agentId,
      baseUrl,
    },
  }
}

export function isDingTalkConfigured(): boolean {
  const clientId = readStringEnv('DINGTALK_CLIENT_ID', 'DINGTALK_APP_KEY')
  const clientSecret = readStringEnv('DINGTALK_CLIENT_SECRET', 'DINGTALK_APP_SECRET')
  const redirectUri = readStringEnv('DINGTALK_REDIRECT_URI')
  if (!clientId || !clientSecret || !redirectUri) return false

  try {
    assertDingTalkCorpAllowed(readStringEnv('DINGTALK_CORP_ID') || null, {
      allowEmpty: true,
      context: 'DINGTALK_CORP_ID',
    })
    return true
  } catch {
    return false
  }
}

export async function exchangeCodeForUserAccessToken(
  code: string,
  config: DingTalkOauthConfig = readDingTalkOauthConfig(),
): Promise<DingTalkUserAccessToken> {
  const payload = await requestDingTalkJson(
    'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code,
        grantType: 'authorization_code',
      }),
    },
    'Failed to obtain access token from DingTalk',
    // One-shot authorization-code exchange: a retry after ANY ambiguous failure
    // burns or double-redeems the single-use code — never retried.
    'exchange',
  )

  const accessToken = typeof payload.accessToken === 'string'
    ? payload.accessToken
    : typeof payload.access_token === 'string'
      ? payload.access_token
      : ''

  if (!accessToken) {
    throw new Error(normalizeErrorMessage(payload, 'Failed to obtain access token from DingTalk'))
  }

  return {
    accessToken,
    expireIn:
      typeof payload.expireIn === 'number'
        ? payload.expireIn
        : typeof payload.expiresIn === 'number'
          ? payload.expiresIn
          : undefined,
    refreshToken:
      typeof payload.refreshToken === 'string'
        ? payload.refreshToken
        : typeof payload.refresh_token === 'string'
          ? payload.refresh_token
          : undefined,
  }
}

export async function fetchDingTalkCurrentUser(accessToken: string): Promise<DingTalkCurrentUserProfile> {
  const payload = await requestDingTalkJson(
    'https://api.dingtalk.com/v1.0/contact/users/me',
    {
      method: 'GET',
      headers: {
        'x-acs-dingtalk-access-token': accessToken,
      },
    },
    'Failed to get current user info from DingTalk',
    'read',
  )

  const openId = typeof payload.openId === 'string'
    ? payload.openId
    : typeof payload.open_id === 'string'
      ? payload.open_id
      : ''
  const unionId = typeof payload.unionId === 'string'
    ? payload.unionId
    : typeof payload.union_id === 'string'
      ? payload.union_id
      : ''
  const nick = typeof payload.nick === 'string'
    ? payload.nick
    : typeof payload.name === 'string'
      ? payload.name
      : ''

  if (!openId) {
    throw new Error(normalizeErrorMessage(payload, 'Failed to resolve DingTalk openId'))
  }

  return {
    openId,
    unionId,
    nick,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    mobile: typeof payload.mobile === 'string' ? payload.mobile : undefined,
    avatarUrl:
      typeof payload.avatarUrl === 'string'
        ? payload.avatarUrl
        : typeof payload.avatar_url === 'string'
          ? payload.avatar_url
          : undefined,
  }
}

// App access-token cache (dingtalk-app-token-cache design-lock, 2026-07-07):
// tokens are valid ~7200s but every caller used to refetch per request,
// multiplying load on the SHARED gettoken quota (directory-sync, work
// notifications, automation executor, attendance delivery worker, E1
// container login). Keyed by appKey|baseUrl; expires_in minus a 120s margin
// (conservative 3300s fallback); failures are never cached; concurrent
// callers share one in-flight request. Known trade-off (lock §2): a secret
// rotated mid-TTL keeps failing until expiry/invalidate/restart.
const APP_TOKEN_EXPIRY_MARGIN_MS = 120 * 1000
const APP_TOKEN_FALLBACK_TTL_MS = 3300 * 1000
const appTokenCache = new Map<string, { token: string; expiresAt: number }>()
const appTokenInFlight = new Map<string, Promise<string>>()

function appTokenCacheKey(config: DingTalkDirectoryConfig): string {
  return `${config.appKey}|${normalizeDirectoryBaseUrl(config.baseUrl)}`
}

export function invalidateDingTalkAppAccessTokenCache(config?: DingTalkDirectoryConfig): void {
  if (config) appTokenCache.delete(appTokenCacheKey(config))
  else appTokenCache.clear()
}

export function __resetDingTalkAppAccessTokenCacheForTests(): void {
  appTokenCache.clear()
  appTokenInFlight.clear()
}

async function fetchDingTalkAppAccessTokenUncached(
  config: DingTalkDirectoryConfig,
  options?: DingTalkRequestOptions,
): Promise<{ token: string; expiresInSeconds: number | null }> {
  const baseUrl = normalizeDirectoryBaseUrl(config.baseUrl)
  const payload = await requestDingTalkDirectoryJson(
    `/gettoken?appkey=${encodeURIComponent(config.appKey)}&appsecret=${encodeURIComponent(config.appSecret)}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    },
    'Failed to obtain DingTalk app access token',
    'read',
    baseUrl,
    options,
  )

  const token = typeof payload.access_token === 'string'
    ? payload.access_token
    : typeof payload.accessToken === 'string'
      ? payload.accessToken
      : ''

  if (!token) {
    throw new Error(normalizeErrorMessage(payload, 'Failed to obtain DingTalk app access token'))
  }

  const expiresRaw = Number(payload.expires_in ?? payload.expiresIn)
  return { token, expiresInSeconds: Number.isFinite(expiresRaw) && expiresRaw > 0 ? expiresRaw : null }
}

export async function fetchDingTalkAppAccessToken(
  config: DingTalkDirectoryConfig,
  options?: DingTalkRequestOptions,
): Promise<string> {
  const key = appTokenCacheKey(config)
  const cached = appTokenCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token
  }
  appTokenCache.delete(key)

  const inFlight = appTokenInFlight.get(key)
  if (inFlight) return inFlight

  const request = (async () => {
    const { token, expiresInSeconds } = await fetchDingTalkAppAccessTokenUncached(config, options)
    const ttlMs = expiresInSeconds !== null
      ? Math.max(expiresInSeconds * 1000 - APP_TOKEN_EXPIRY_MARGIN_MS, 30 * 1000)
      : APP_TOKEN_FALLBACK_TTL_MS
    appTokenCache.set(key, { token, expiresAt: Date.now() + ttlMs })
    return token
  })()
  appTokenInFlight.set(key, request)
  try {
    return await request
  } finally {
    appTokenInFlight.delete(key)
  }
}

export async function listDingTalkDepartments(
  accessToken: string,
  rootDepartmentId: string,
  config?: { baseUrl?: string },
): Promise<DingTalkDepartment[]> {
  const payload = await requestDingTalkDirectoryJson(
    `/topapi/v2/department/listsub?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dept_id: Number.isNaN(Number(rootDepartmentId)) ? rootDepartmentId : Number(rootDepartmentId),
      }),
    },
    'Failed to list DingTalk departments',
    // POST-verb but a query-shaped read — safe to retry.
    'read',
    config?.baseUrl,
  )

  const nestedResult = payload.result
  const rawList = Array.isArray(nestedResult)
    ? nestedResult
    : nestedResult && typeof nestedResult === 'object' && Array.isArray((nestedResult as Record<string, unknown>).list)
      ? (nestedResult as Record<string, unknown>).list as unknown[]
      : []
  return rawList
    .map((entry) => (entry && typeof entry === 'object' ? entry as Record<string, unknown> : null))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      id: String(entry.dept_id ?? entry.id ?? '').trim(),
      parentId:
        entry.parent_id === null || entry.parent_id === undefined
          ? null
          : String(entry.parent_id).trim() || null,
      name: String(entry.name ?? '').trim(),
      order: readNumericField(entry, 'order', 'order_index') ?? 0,
      source: entry,
    }))
    .filter((entry) => entry.id.length > 0 && entry.name.length > 0)
}

export async function getDingTalkDepartmentDetail(
  accessToken: string,
  departmentId: string,
  config?: { baseUrl?: string },
): Promise<{ deptManagerUserIdList: string[] }> {
  const payload = await requestDingTalkDirectoryJson(
    `/topapi/v2/department/get?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dept_id: Number.isNaN(Number(departmentId)) ? departmentId : Number(departmentId),
      }),
    },
    'Failed to read DingTalk department detail',
    'read',
    config?.baseUrl,
  )

  const result = readNestedPayload(payload)
  // DingTalk `/topapi/v2/department/get` returns `dept_manager_userid_list` as a
  // comma-separated string of userids; tolerate an array too for forward-compat.
  const rawManagers = result.dept_manager_userid_list ?? result.deptManagerUseridList
  const deptManagerUserIdList = Array.isArray(rawManagers)
    ? rawManagers.map((item) => String(item ?? '').trim()).filter(Boolean)
    : typeof rawManagers === 'string'
      ? rawManagers.split(',').map((item) => item.trim()).filter(Boolean)
      : []
  return { deptManagerUserIdList }
}

export async function listDingTalkDepartmentUsers(
  accessToken: string,
  departmentId: string,
  cursor: number,
  size: number,
  config?: { baseUrl?: string; containAccessLimit?: boolean },
): Promise<{ users: DingTalkDepartmentUserSummary[]; nextCursor: number | null; hasMore: boolean }> {
  const payload = await requestDingTalkDirectoryJson(
    `/topapi/v2/user/list?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dept_id: Number.isNaN(Number(departmentId)) ? departmentId : Number(departmentId),
        cursor,
        size,
        contain_access_limit: config?.containAccessLimit === true,
        language: 'zh_CN',
      }),
    },
    'Failed to list DingTalk department users',
    'read',
    config?.baseUrl,
  )

  const result = readNestedPayload(payload)
  const rawList = Array.isArray(result.list) ? result.list : []
  const users = rawList
    .map((entry) => (entry && typeof entry === 'object' ? entry as Record<string, unknown> : null))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => {
      const departmentIds = Array.isArray(entry.dept_id_list)
        ? entry.dept_id_list.map((item) => String(item ?? '').trim()).filter(Boolean)
        : [departmentId]

      return {
        userId: String(entry.userid ?? entry.userId ?? '').trim(),
        name: String(entry.name ?? '').trim(),
        unionId: typeof entry.unionid === 'string' ? entry.unionid : typeof entry.unionId === 'string' ? entry.unionId : undefined,
        mobile: typeof entry.mobile === 'string' ? entry.mobile : undefined,
        email: typeof entry.email === 'string' ? entry.email : undefined,
        title: typeof entry.title === 'string' ? entry.title : undefined,
        avatarUrl:
          typeof entry.avatar === 'string'
            ? entry.avatar
            : typeof entry.avatarUrl === 'string'
              ? entry.avatarUrl
              : undefined,
        departmentIds,
        source: entry,
      }
    })
    .filter((entry) => entry.userId.length > 0 && entry.name.length > 0)

  return {
    users,
    nextCursor: readNumericField(result, 'next_cursor', 'nextCursor'),
    hasMore: Boolean(result.has_more),
  }
}

export async function getDingTalkUserDetail(
  accessToken: string,
  userId: string,
  config?: { baseUrl?: string },
): Promise<DingTalkDirectoryUser> {
  const payload = await requestDingTalkDirectoryJson(
    `/topapi/v2/user/get?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userid: userId,
        language: 'zh_CN',
      }),
    },
    'Failed to read DingTalk user detail',
    'read',
    config?.baseUrl,
  )

  const result = readNestedPayload(payload)
  const departmentIds = Array.isArray(result.dept_id_list)
    ? result.dept_id_list.map((item) => String(item ?? '').trim()).filter(Boolean)
    : []

  const resolvedUserId = String(result.userid ?? result.userId ?? userId).trim()
  const name = String(result.name ?? '').trim()
  if (!resolvedUserId || !name) {
    throw new Error('Failed to resolve DingTalk user detail')
  }

  return {
    userId: resolvedUserId,
    name,
    nick: typeof result.nick === 'string' ? result.nick : undefined,
    unionId: typeof result.unionid === 'string' ? result.unionid : typeof result.unionId === 'string' ? result.unionId : undefined,
    openId: typeof result.openId === 'string' ? result.openId : typeof result.open_id === 'string' ? result.open_id : undefined,
    mobile: typeof result.mobile === 'string' ? result.mobile : undefined,
    email: typeof result.email === 'string' ? result.email : undefined,
    jobNumber: typeof result.job_number === 'string' ? result.job_number : typeof result.jobNumber === 'string' ? result.jobNumber : undefined,
    title: typeof result.title === 'string' ? result.title : undefined,
    avatarUrl:
      typeof result.avatar === 'string'
        ? result.avatar
        : typeof result.avatarUrl === 'string'
          ? result.avatarUrl
          : undefined,
    departmentIds,
    source: result,
  }
}

/**
 * E1 container login (attendance-e1-container-login design-lock §1.4): exchange
 * an in-container enterprise 免登 authCode for the corp userid. Distinct grant
 * from the v1.0 web-OAuth userAccessToken exchange above — this one runs on the
 * APP access token (fetchDingTalkAppAccessToken) via the legacy topapi shape.
 */
export interface DingTalkContainerUserInfo {
  userId: string
  unionId?: string
  sysLevel?: number
  source: Record<string, unknown>
}

export async function getDingTalkUserInfoByAuthCode(
  accessToken: string,
  authCode: string,
  config?: { baseUrl?: string },
): Promise<DingTalkContainerUserInfo> {
  const payload = await requestDingTalkDirectoryJson(
    `/topapi/v2/user/getuserinfo?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: authCode }),
    },
    'Failed to exchange DingTalk container auth code',
    // One-shot container authCode: a retry after ANY ambiguous failure burns or
    // double-redeems the single-use code — never retried.
    'exchange',
    config?.baseUrl,
  )

  const result = readNestedPayload(payload)
  const userId = String(result.userid ?? result.userId ?? '').trim()
  if (!userId) {
    throw new Error('DingTalk container auth code exchange returned no userid')
  }
  const unionIdRaw = result.unionid ?? result.unionId
  const sysLevelRaw = Number(result.sys_level ?? result.sysLevel)
  return {
    userId,
    unionId: typeof unionIdRaw === 'string' && unionIdRaw.trim() ? unionIdRaw.trim() : undefined,
    sysLevel: Number.isFinite(sysLevelRaw) ? sysLevelRaw : undefined,
    source: result,
  }
}

/**
 * A-2b (one-tap lock #3594): action_card work notification — same corp-app channel as the markdown
 * variant, but the OA `action_card` msgtype renders a tappable button (URL jump; in-chat callback
 * buttons are the Slice-B interactive-card upgrade). Single-button form only.
 */
export interface DingTalkWorkNotificationActionCardInput {
  userIds: string[]
  title: string
  /** Card body, markdown subset per the OA action_card contract. */
  markdown: string
  /** Button label (e.g. 查看并处理). */
  singleTitle: string
  /** Button target URL — the signed decision deep link. */
  singleUrl: string
}

export const DINGTALK_INTERACTIVE_APPROVAL_CARD_CALLBACK_ROUTE_KEY = 'approval_card'

export interface DingTalkInteractiveApprovalCardInput {
  /** Recipient DingTalk user id. B-2 uses one card per approver. */
  userId: string
  /** Robot/app code that owns the interactive-card Stream callback. */
  robotCode: string
  /** DingTalk interactive-card template id from the Stream-card env gate. */
  cardTemplateId: string
  /** Must equal dingtalk_approval_card_deliveries.id; callback payloads are never business anchors. */
  outTrackId: string
  title: string
  requestNo?: string
  nodeName: string
  statusText: string
  rejectUrl: string
  callbackRouteKey?: string
}

export interface DingTalkInteractiveCardConfig {
  openApiBaseUrl?: string
}

function normalizeDingTalkOpenApiBaseUrl(baseUrl?: string): string {
  const normalized = typeof baseUrl === 'string' && baseUrl.trim().length > 0
    ? baseUrl.trim()
    : readStringEnv('DINGTALK_OPEN_API_BASE_URL') || 'https://api.dingtalk.com'
  return normalized.replace(/\/+$/, '')
}

function readStringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function readFirstRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (Array.isArray(value)) {
    const first = value[0]
    if (first && typeof first === 'object' && !Array.isArray(first)) return first as Record<string, unknown>
  }
  return null
}

function readInteractiveCardTaskId(payload: Record<string, unknown>): string | undefined {
  const result = readNestedPayload(payload)
  const deliverResult = readFirstRecord(result.deliverResults ?? result.deliveryResults ?? payload.deliverResults)
  return readStringField(result, 'taskId', 'task_id', 'cardInstanceId', 'card_instance_id', 'processQueryKey')
    ?? readStringField(deliverResult ?? {}, 'taskId', 'task_id', 'cardInstanceId', 'card_instance_id', 'carrierId', 'deliverId')
    ?? readStringField(payload, 'taskId', 'task_id', 'requestId', 'request_id')
}

function assertInteractiveCardDeliverySucceeded(payload: Record<string, unknown>): void {
  if (payload.success !== true) {
    throw new DingTalkBusinessError(
      normalizeErrorMessage(payload, 'DingTalk interactive-card create-and-deliver failed'),
      payload,
    )
  }

  const result = readNestedPayload(payload)
  const rawDeliverResults = result.deliverResults ?? result.deliveryResults
  const deliverResults = Array.isArray(rawDeliverResults)
    ? rawDeliverResults.filter((value): value is Record<string, unknown> => (
        value !== null && typeof value === 'object' && !Array.isArray(value)
      ))
    : []
  if (deliverResults.length === 0) {
    throw new DingTalkBusinessError('DingTalk interactive-card response contained no delivery result', payload)
  }

  const failure = deliverResults.find((delivery) => delivery.success !== true)
  if (failure) {
    throw new DingTalkBusinessError(
      readStringField(failure, 'errorMsg', 'errorMessage')
        ?? 'DingTalk interactive-card delivery failed',
      payload,
    )
  }
}

/**
 * B-2 (interactive approval cards): create-and-deliver a DingTalk interactive card.
 *
 * This is SEND-ONLY. The approve button is represented as Stream callback metadata for B-3;
 * reject still jumps to the Slice-A decision page because rejection comments remain mandatory.
 */
export async function sendDingTalkInteractiveApprovalCard(
  accessToken: string,
  input: DingTalkInteractiveApprovalCardInput,
  config: DingTalkInteractiveCardConfig = {},
  options?: DingTalkRequestOptions,
): Promise<DingTalkWorkNotificationResult> {
  const userId = input.userId.trim()
  const robotCode = input.robotCode.trim()
  const cardTemplateId = input.cardTemplateId.trim()
  const outTrackId = input.outTrackId.trim()
  const title = input.title.trim()
  const nodeName = input.nodeName.trim()
  const statusText = input.statusText.trim()
  const rejectUrl = input.rejectUrl.trim()
  const requestNo = typeof input.requestNo === 'string' ? input.requestNo.trim() : ''
  const callbackRouteKey = (input.callbackRouteKey ?? DINGTALK_INTERACTIVE_APPROVAL_CARD_CALLBACK_ROUTE_KEY).trim()

  if (!accessToken.trim()) throw new Error('DingTalk access token is required')
  if (!userId) throw new Error('DingTalk userId is required')
  if (!robotCode) throw new Error('DingTalk interactive-card robotCode is required')
  if (!cardTemplateId) throw new Error('DingTalk interactive-card template id is required')
  if (!outTrackId) throw new Error('DingTalk interactive-card outTrackId is required')
  if (!title) throw new Error('DingTalk interactive-card title is required')
  if (!nodeName) throw new Error('DingTalk interactive-card node name is required')
  if (!statusText) throw new Error('DingTalk interactive-card status text is required')
  if (!rejectUrl) throw new Error('DingTalk interactive-card reject url is required')
  if (!callbackRouteKey) throw new Error('DingTalk interactive-card callback route key is required')

  const openSpaceId = `dtv1.card//im_robot.${userId}`
  const payload = await requestDingTalkJson(
    `${normalizeDingTalkOpenApiBaseUrl(config.openApiBaseUrl)}/v1.0/card/instances/createAndDeliver`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify({
        userId,
        userIdType: 1,
        cardTemplateId,
        outTrackId,
        callbackType: 'STREAM',
        callbackRouteKey,
        cardData: {
          cardParamMap: {
            title,
            requestNo,
            nodeName,
            statusText,
            approveText: '同意',
            rejectText: '驳回',
            rejectUrl,
          },
        },
        openSpaceId,
        imRobotOpenSpaceModel: {
          supportForward: false,
        },
        imRobotOpenDeliverModel: {
          robotCode,
          spaceType: 'IM_ROBOT',
        },
      }),
    },
    'Failed to send DingTalk interactive approval card',
    options,
  )

  assertInteractiveCardDeliverySucceeded(payload)

  return {
    taskId: readInteractiveCardTaskId(payload) ?? outTrackId,
    requestId: readStringField(payload, 'requestId', 'request_id'),
    raw: payload,
  }
}

export async function sendDingTalkWorkNotificationActionCard(
  accessToken: string,
  input: DingTalkWorkNotificationActionCardInput,
  config: DingTalkMessageConfig = readDingTalkMessageConfig(),
  options?: DingTalkRequestOptions,
): Promise<DingTalkWorkNotificationResult> {
  const userIds = Array.from(new Set(
    input.userIds
      .map((userId) => String(userId ?? '').trim())
      .filter(Boolean),
  ))
  const title = input.title.trim()
  const markdown = input.markdown.trim()
  const singleTitle = input.singleTitle.trim()
  const singleUrl = input.singleUrl.trim()

  if (userIds.length === 0) throw new Error('At least one DingTalk userId is required')
  if (!title) throw new Error('DingTalk title is required')
  if (!markdown) throw new Error('DingTalk markdown is required')
  if (!singleTitle || !singleUrl) throw new Error('DingTalk action_card button title and url are required')

  const payload = await requestDingTalkDirectoryJson(
    `/topapi/message/corpconversation/asyncsend_v2?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: Number.isNaN(Number(config.agentId)) ? config.agentId : Number(config.agentId),
        userid_list: userIds.join(','),
        to_all_user: false,
        msg: {
          msgtype: 'action_card',
          action_card: {
            title,
            markdown,
            single_title: singleTitle,
            single_url: singleUrl,
          },
        },
      }),
    },
    'Failed to send DingTalk action-card work notification',
    // Side-effect send: never auto-retried. A lost response has no task_id, so
    // DingTalk's async-send result query cannot serve as an idempotency key —
    // uncertain outcomes surface via isDingTalkOutcomeUnknown instead.
    'send',
    config.baseUrl,
    options,
  )

  const result = readNestedPayload(payload)
  const taskIdValue = payload.task_id ?? payload.taskId ?? result.task_id ?? result.taskId
  const requestIdValue = payload.request_id ?? payload.requestId ?? result.request_id ?? result.requestId
  return {
    taskId:
      typeof taskIdValue === 'number'
        ? String(taskIdValue)
        : typeof taskIdValue === 'string'
          ? taskIdValue
              : undefined,
    requestId:
      typeof requestIdValue === 'string'
        ? requestIdValue
          : undefined,
    raw: payload,
  }
}

export async function sendDingTalkWorkNotification(
  accessToken: string,
  input: DingTalkWorkNotificationInput,
  config: DingTalkMessageConfig = readDingTalkMessageConfig(),
  options?: DingTalkRequestOptions,
): Promise<DingTalkWorkNotificationResult> {
  const userIds = Array.from(new Set(
    input.userIds
      .map((userId) => String(userId ?? '').trim())
      .filter(Boolean),
  ))
  const title = input.title.trim()
  const content = input.content.trim()

  if (userIds.length === 0) throw new Error('At least one DingTalk userId is required')
  if (!title) throw new Error('DingTalk title is required')
  if (!content) throw new Error('DingTalk content is required')

  const payload = await requestDingTalkDirectoryJson(
    `/topapi/message/corpconversation/asyncsend_v2?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: Number.isNaN(Number(config.agentId)) ? config.agentId : Number(config.agentId),
        userid_list: userIds.join(','),
        to_all_user: false,
        msg: {
          msgtype: 'markdown',
          markdown: {
            title,
            text: `### ${title}\n\n${content}`,
          },
        },
      }),
    },
    'Failed to send DingTalk work notification',
    // Side-effect send: never auto-retried. A lost response has no task_id, so
    // DingTalk's async-send result query cannot serve as an idempotency key —
    // uncertain outcomes surface via isDingTalkOutcomeUnknown instead.
    'send',
    config.baseUrl,
    options,
  )

  const result = readNestedPayload(payload)
  const taskIdValue = payload.task_id ?? payload.taskId ?? result.task_id ?? result.taskId
  const requestIdValue = payload.request_id ?? payload.requestId ?? result.request_id ?? result.requestId
  return {
    taskId:
      typeof taskIdValue === 'number'
        ? String(taskIdValue)
        : typeof taskIdValue === 'string'
          ? taskIdValue
              : undefined,
    requestId:
      typeof requestIdValue === 'string'
        ? requestIdValue
          : undefined,
    raw: payload,
  }
}
