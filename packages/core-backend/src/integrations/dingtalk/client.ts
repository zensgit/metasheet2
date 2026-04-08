import { Logger } from '../../core/logger'

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

class DingTalkRequestError extends Error {
  statusCode: number
  responseBody: Record<string, unknown> | null

  constructor(message: string, statusCode: number, responseBody: Record<string, unknown> | null) {
    super(message)
    this.name = 'DingTalkRequestError'
    this.statusCode = statusCode
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
): Promise<Record<string, unknown>> {
  const response = await fetch(input, init)
  const payload = await readJson(response)

  if (!response.ok) {
    const message = normalizeErrorMessage(payload, fallbackError)
    logger.warn(`DingTalk request failed (${response.status}): ${message}`)
    throw new DingTalkRequestError(message, response.status, payload)
  }

  return payload ?? {}
}

export function readDingTalkOauthConfig(): DingTalkOauthConfig {
  const clientId = readStringEnv('DINGTALK_CLIENT_ID', 'DINGTALK_APP_KEY')
  const clientSecret = readStringEnv('DINGTALK_CLIENT_SECRET', 'DINGTALK_APP_SECRET')
  const redirectUri = readStringEnv('DINGTALK_REDIRECT_URI')
  const corpId = readStringEnv('DINGTALK_CORP_ID') || null

  if (!clientId) throw new Error('DINGTALK_CLIENT_ID or DINGTALK_APP_KEY is not configured')
  if (!clientSecret) throw new Error('DINGTALK_CLIENT_SECRET or DINGTALK_APP_SECRET is not configured')
  if (!redirectUri) throw new Error('DINGTALK_REDIRECT_URI is not configured')

  return {
    clientId,
    clientSecret,
    redirectUri,
    corpId,
  }
}

export function isDingTalkConfigured(): boolean {
  return Boolean(
    readStringEnv('DINGTALK_CLIENT_ID', 'DINGTALK_APP_KEY') &&
    readStringEnv('DINGTALK_CLIENT_SECRET', 'DINGTALK_APP_SECRET') &&
    readStringEnv('DINGTALK_REDIRECT_URI'),
  )
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

export { DingTalkRequestError }
