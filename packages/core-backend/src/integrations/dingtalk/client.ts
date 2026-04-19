import { Logger } from '../../core/logger'
import { assertDingTalkCorpAllowed } from './runtime-policy'

const logger = new Logger('DingTalkClient')

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
}

export interface DingTalkDepartment {
  id: string
  parentId: string | null
  name: string
  order: number
  source: Record<string, unknown>
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

function readStringEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return ''
}

function normalizeErrorMessage(payload: Record<string, unknown> | null, fallback: string): string {
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

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const payload = await response.json()
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  } catch {
    return null
  }
}

async function requestDingTalkJson(
  input: string,
  init: RequestInit,
  fallbackError: string,
  options?: DingTalkRequestOptions,
): Promise<Record<string, unknown>> {
  const response = await (options?.fetchFn ?? fetch)(input, init)
  const payload = await readJson(response)

  if (!response.ok) {
    const message = normalizeErrorMessage(payload, fallbackError)
    logger.warn(`DingTalk request failed (${response.status}): ${message}`)
    throw new DingTalkRequestError(message, response.status, payload)
  }

  return payload ?? {}
}

function readNumericField(payload: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'number') return value
    if (typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Number(value))) {
      return Number(value)
    }
  }
  return null
}

function readNestedPayload(payload: Record<string, unknown>, key = 'result'): Record<string, unknown> {
  const nested = payload[key]
  return nested && typeof nested === 'object' ? nested as Record<string, unknown> : {}
}

function normalizeDingTalkApiPayload(payload: Record<string, unknown>, fallbackError: string): Record<string, unknown> {
  const errcode = readNumericField(payload, 'errcode', 'code')
  if (errcode !== null && errcode !== 0) {
    throw new DingTalkBusinessError(normalizeErrorMessage(payload, fallbackError), payload)
  }
  return payload
}

function normalizeDirectoryBaseUrl(baseUrl?: string): string {
  const normalized = typeof baseUrl === 'string' && baseUrl.trim().length > 0
    ? baseUrl.trim()
    : 'https://oapi.dingtalk.com'
  return normalized.replace(/\/+$/, '')
}

async function requestDingTalkDirectoryJson(
  path: string,
  init: RequestInit,
  fallbackError: string,
  baseUrl?: string,
  options?: DingTalkRequestOptions,
): Promise<Record<string, unknown>> {
  const payload = await requestDingTalkJson(
    `${normalizeDirectoryBaseUrl(baseUrl)}${path}`,
    init,
    fallbackError,
    options,
  )
  return normalizeDingTalkApiPayload(payload, fallbackError)
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

export async function fetchDingTalkAppAccessToken(
  config: DingTalkDirectoryConfig,
  options?: DingTalkRequestOptions,
): Promise<string> {
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

  return token
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
