import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { Logger } from '../core/logger'
import { secretManager } from '../security/SecretManager'

export type DingTalkAuthMode = 'login' | 'bind'

export type DingTalkAuthState = {
  type: 'dingtalk-auth'
  mode: DingTalkAuthMode
  redirect: string
  requestedBy?: string
  nonce: string
  iat: number
  exp: number
}

export type DingTalkIdentityProfile = {
  provider: 'dingtalk'
  userId: string | null
  unionId: string | null
  openId: string | null
  corpId: string | null
  name: string | null
  nick: string | null
  email: string | null
  avatarUrl: string | null
  mobile: string | null
  raw: Record<string, unknown>
}

export type DingTalkAuthExchangeStage = 'token' | 'user-info'

export class DingTalkAuthExchangeError extends Error {
  readonly stage: DingTalkAuthExchangeStage
  readonly status: number
  readonly details?: Record<string, unknown>

  constructor(
    stage: DingTalkAuthExchangeStage,
    status: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'DingTalkAuthExchangeError'
    this.stage = stage
    this.status = status
    this.details = details
  }
}

export function isDingTalkAuthExchangeError(error: unknown): error is DingTalkAuthExchangeError {
  return error instanceof DingTalkAuthExchangeError
}

type DingTalkAuthConfig = {
  enabled: boolean
  clientId: string
  clientSecret: string
  redirectUri: string
  authBaseUrl: string
  tokenUrl: string
  userInfoUrl: string
  stateSecret: string
  stateTtlSeconds: number
  scope: string
  autoProvisionEnabled: boolean
  autoProvisionPresetId: string
  autoProvisionOrgId: string
  autoProvisionEmailDomain: string
  allowedCorpIds: string[]
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeRedirectPath(value: unknown): string {
  if (typeof value !== 'string') return '/attendance'
  const trimmed = value.trim()
  if (!trimmed.startsWith('/')) return '/attendance'
  if (trimmed.startsWith('//')) return '/attendance'
  return trimmed
}

function parseArrayEnv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function sanitizeExchangePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...payload }
  for (const key of ['accessToken', 'access_token', 'userAccessToken', 'user_access_token', 'refreshToken', 'refresh_token']) {
    if (key in redacted) {
      redacted[key] = '[redacted]'
    }
  }
  return redacted
}

export class DingTalkAuthService {
  private readonly logger = new Logger('DingTalkAuthService')

  private readonly config: DingTalkAuthConfig = {
    enabled: process.env.DINGTALK_AUTH_ENABLED !== 'false',
    clientId: secretManager.get('DINGTALK_CLIENT_ID', {
      required: false,
      fallback: process.env.DINGTALK_APP_KEY || '',
    }) || '',
    clientSecret: secretManager.get('DINGTALK_CLIENT_SECRET', {
      required: false,
      fallback: process.env.DINGTALK_APP_SECRET || '',
    }) || '',
    redirectUri: (process.env.DINGTALK_REDIRECT_URI || process.env.PUBLIC_APP_URL || '').trim().replace(/\/$/, '')
      ? `${(process.env.DINGTALK_REDIRECT_URI || `${(process.env.PUBLIC_APP_URL || '').trim().replace(/\/$/, '')}/auth/dingtalk/callback`).trim()}`
      : '',
    authBaseUrl: (process.env.DINGTALK_AUTH_BASE_URL || 'https://login.dingtalk.com/oauth2/auth').trim(),
    tokenUrl: (process.env.DINGTALK_TOKEN_URL || 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken').trim(),
    userInfoUrl: (process.env.DINGTALK_USER_INFO_URL || 'https://api.dingtalk.com/v1.0/contact/users/me').trim(),
    stateSecret: secretManager.get('DINGTALK_STATE_SECRET', {
      required: false,
      fallback: process.env.JWT_SECRET || 'fallback-dingtalk-state-secret',
    }) || 'fallback-dingtalk-state-secret',
    stateTtlSeconds: Math.max(60, Number(process.env.DINGTALK_STATE_TTL_SECONDS || 600)),
    scope: (process.env.DINGTALK_SCOPE || 'openid corpid').trim(),
    autoProvisionEnabled: process.env.DINGTALK_AUTO_PROVISION === 'true',
    autoProvisionPresetId: (process.env.DINGTALK_AUTO_PROVISION_PRESET_ID || 'attendance-employee').trim(),
    autoProvisionOrgId: (process.env.DINGTALK_AUTO_PROVISION_ORG_ID || 'default').trim(),
    autoProvisionEmailDomain: (process.env.DINGTALK_AUTO_PROVISION_EMAIL_DOMAIN || 'dingtalk.local').trim(),
    allowedCorpIds: parseArrayEnv(process.env.DINGTALK_ALLOWED_CORP_IDS),
  }

  isEnabled(): boolean {
    return this.config.enabled
  }

  isConfigured(): boolean {
    return this.isEnabled()
      && this.config.clientId.length > 0
      && this.config.clientSecret.length > 0
      && this.config.redirectUri.length > 0
  }

  getProvisioningConfig(): Pick<DingTalkAuthConfig, 'autoProvisionEnabled' | 'autoProvisionPresetId' | 'autoProvisionOrgId' | 'autoProvisionEmailDomain' | 'allowedCorpIds'> {
    return {
      autoProvisionEnabled: this.config.autoProvisionEnabled,
      autoProvisionPresetId: this.config.autoProvisionPresetId,
      autoProvisionOrgId: this.config.autoProvisionOrgId,
      autoProvisionEmailDomain: this.config.autoProvisionEmailDomain,
      allowedCorpIds: [...this.config.allowedCorpIds],
    }
  }

  createState(input: {
    mode: DingTalkAuthMode
    redirect?: string
    requestedBy?: string
  }): { state: string; redirect: string } {
    const redirect = normalizeRedirectPath(input.redirect)
    const state = jwt.sign(
      {
        type: 'dingtalk-auth',
        mode: input.mode,
        redirect,
        requestedBy: normalizeText(input.requestedBy) || undefined,
        nonce: crypto.randomUUID(),
      },
      this.config.stateSecret,
      {
        expiresIn: this.config.stateTtlSeconds,
      },
    )

    return { state, redirect }
  }

  verifyState(value: string): DingTalkAuthState | null {
    try {
      const payload = jwt.verify(value, this.config.stateSecret) as DingTalkAuthState
      if (payload?.type !== 'dingtalk-auth') return null
      if (payload.mode !== 'login' && payload.mode !== 'bind') return null
      return {
        ...payload,
        redirect: normalizeRedirectPath(payload.redirect),
        requestedBy: normalizeText(payload.requestedBy) || undefined,
      }
    } catch (error) {
      this.logger.warn('DingTalk auth state verification failed', error instanceof Error ? error : undefined)
      return null
    }
  }

  buildAuthorizeUrl(input: {
    mode: DingTalkAuthMode
    redirect?: string
    requestedBy?: string
  }): { url: string; state: string; redirect: string } {
    const { state, redirect } = this.createState(input)
    const params = new URLSearchParams({
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      client_id: this.config.clientId,
      scope: this.config.scope,
      state,
      prompt: 'consent',
    })
    return {
      url: `${this.config.authBaseUrl}?${params.toString()}`,
      state,
      redirect,
    }
  }

  async exchangeCode(code: string): Promise<DingTalkIdentityProfile> {
    if (!this.isConfigured()) {
      throw new Error('DingTalk auth is not configured')
    }

    let tokenResponse: Response
    try {
      tokenResponse = await fetch(this.config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
          code,
          grantType: 'authorization_code',
        }),
      })
    } catch (error) {
      throw new DingTalkAuthExchangeError(
        'token',
        502,
        'Failed to reach DingTalk token endpoint',
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      )
    }

    const tokenPayload = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>
    if (!tokenResponse.ok) {
      throw new DingTalkAuthExchangeError(
        'token',
        tokenResponse.status || 502,
        normalizeText(tokenPayload.message) || normalizeText(tokenPayload.errmsg) || 'Failed to exchange DingTalk auth code',
        {
          payload: sanitizeExchangePayload(tokenPayload),
        },
      )
    }

    const accessToken = normalizeText(tokenPayload.accessToken)
      || normalizeText(tokenPayload.access_token)
      || normalizeText(tokenPayload.userAccessToken)
      || normalizeText(tokenPayload.user_access_token)
    if (!accessToken) {
      throw new DingTalkAuthExchangeError(
        'token',
        502,
        'Missing DingTalk access token',
        {
          payload: sanitizeExchangePayload(tokenPayload),
        },
      )
    }

    let userInfoResponse: Response
    try {
      userInfoResponse = await fetch(this.config.userInfoUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'x-acs-dingtalk-access-token': accessToken,
        },
      })
    } catch (error) {
      throw new DingTalkAuthExchangeError(
        'user-info',
        502,
        'Failed to reach DingTalk user info endpoint',
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      )
    }
    const userInfoPayload = await userInfoResponse.json().catch(() => ({})) as Record<string, unknown>
    if (!userInfoResponse.ok) {
      throw new DingTalkAuthExchangeError(
        'user-info',
        userInfoResponse.status || 502,
        normalizeText(userInfoPayload.message) || normalizeText(userInfoPayload.errmsg) || 'Failed to fetch DingTalk user info',
        {
          payload: sanitizeExchangePayload(userInfoPayload),
        },
      )
    }

    return this.normalizeProfile({
      ...toRecord(tokenPayload),
      profile: toRecord(userInfoPayload),
      ...toRecord(userInfoPayload),
    })
  }

  private normalizeProfile(payload: Record<string, unknown>): DingTalkIdentityProfile {
    const profile = toRecord(payload.profile)
    const corpId = normalizeText(profile.corpId)
      || normalizeText(profile.corp_id)
      || normalizeText(payload.corpId)
      || normalizeText(payload.corp_id)
    const userId = normalizeText(profile.userId)
      || normalizeText(profile.userid)
      || normalizeText(profile.staffId)
      || normalizeText(profile.staff_id)
      || normalizeText(payload.userId)
      || normalizeText(payload.userid)
      || normalizeText(payload.staffId)
    const unionId = normalizeText(profile.unionId)
      || normalizeText(profile.unionid)
      || normalizeText(payload.unionId)
      || normalizeText(payload.unionid)
    const openId = normalizeText(profile.openId)
      || normalizeText(profile.openid)
      || normalizeText(payload.openId)
      || normalizeText(payload.openid)

    return {
      provider: 'dingtalk',
      userId,
      unionId,
      openId,
      corpId,
      name: normalizeText(profile.name) || normalizeText(profile.realName) || normalizeText(payload.name),
      nick: normalizeText(profile.nick) || normalizeText(payload.nick),
      email: normalizeText(profile.orgEmail) || normalizeText(profile.email) || normalizeText(payload.email),
      avatarUrl: normalizeText(profile.avatarUrl) || normalizeText(profile.avatar) || normalizeText(payload.avatarUrl),
      mobile: normalizeText(profile.mobile) || normalizeText(payload.mobile),
      raw: payload,
    }
  }
}

export const dingTalkAuthService = new DingTalkAuthService()
