import {
  classifyWeComErrcode,
  exchangeWeComLoginCode,
  getWeComMember,
  isValidWeComAgentId,
  isValidWeComCorpId,
  isValidWeComLoginCode,
  isValidWeComUserId,
  isWeComTokenStageError,
  WeComBusinessError,
  WeComIncompleteResponseError,
  WeComInvalidInputError,
  WeComRequestError,
  WeComTimeoutError,
  WeComTransportError,
  type WeComRequestOptions,
} from '../../integrations/wecom/client'

/**
 * WeCom (企业微信) identity adapter, provider side: the authorization URL, the login-code exchange,
 * the online member check and the subject it resolves. It reads no environment, writes nothing, has
 * no route and no database access; every WeCom request goes through the strict read layer of the
 * client, so no code, token, secret, URL or provider text reaches a result, an error or a log line.
 */

/** Assurance levels this adapter can state; the platform-asserted level is never produced here. */
export type WeComIdentityAssuranceLevel = 'unknown' | 'external_platform_asserted'

/** The assurance this adapter stamps on every resolved subject. It has no input that changes it. */
export const WECOM_IDENTITY_ASSURANCE = 'unknown' as const

/** Revision of the subject-resolution rules in this file; recorded next to the assurance at bind time. */
export const WECOM_IDENTITY_ADAPTER_REV = 1

/** Host of the web login component (not the API host the client talks to). */
const WECOM_LOGIN_AUTHORIZE_URL = 'https://login.work.weixin.qq.com/wwlogin/sso/login'
const WECOM_LOGIN_STATE_PATTERN = /^[0-9a-f]{32}$/

/** The connection facts the adapter needs; they come from stored configuration, never from a request. */
export interface WeComIdentityConnection {
  /** Integration id of the connection. */
  id: string
  corpId: string
  wecomAgentId: string
}

export interface WeComIdentityCredentials {
  corpSecret: string
  baseUrl?: string
}

/** The subject a successful exchange resolves: configuration-derived scope plus the scanned member. */
export interface ResolvedExternalSubject {
  provider: 'wecom'
  connectionId: string
  tenant: string
  appScope: string
  subjectType: 'wecom_userid'
  /** Lower-cased userid. */
  subjectKey: string
  /** The userid exactly as WeCom returned it. */
  providerUserId: string
  memberVerification: 'online_verified'
}

export type WeComIdentityAdminReason =
  | 'trusted_ip'
  | 'invalid_corp'
  | 'invalid_agent'
  | 'redirect_domain'
  | 'config_fault'

export type WeComIdentityRejectedReason =
  | 'subject_not_member'
  | 'subject_invalid'
  | 'subject_unknown'
  | 'subject_out_of_scope'
  | 'subject_inactive'
  | 'code_invalid'
  | 'config_fault'
  | 'permission_fault'
  | 'provider_error'

export type WeComIdentityUnavailableReason =
  | 'token_unavailable'
  | 'rate_limited'
  | 'busy'
  | 'timeout'
  | 'transport'
  | 'incomplete_response'

export type WeComIdentityResult =
  | { ok: true; subject: ResolvedExternalSubject }
  | {
      ok: false
      outcome: 'rejected'
      reason: WeComIdentityRejectedReason
      /** Present only for `config_fault`; for administrators, never for the person logging in. */
      adminReason?: WeComIdentityAdminReason
    }
  | { ok: false; outcome: 'unavailable'; reason: WeComIdentityUnavailableReason }

/** The deployment-level redirect address is not acceptable. Carries no value. */
export class WeComRedirectUriError extends Error {
  constructor() {
    super('WeCom login redirect address is invalid')
    this.name = 'WeComRedirectUriError'
  }
}

/** The authorization state is not a 32-character lower-case hexadecimal string. Carries no value. */
export class WeComLoginStateError extends Error {
  constructor() {
    super('WeCom login state is invalid')
    this.name = 'WeComLoginStateError'
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export interface WeComLoginRedirectOptions {
  /** Accepts `http` for a loopback host. Only a test injects it. */
  allowLoopbackHttp?: boolean
}

/**
 * Validates the deployment-level redirect address and returns its normalised form: `https`, no
 * userinfo, no query, no fragment, lower-cased host with a default port dropped.
 */
export function normalizeWeComLoginRedirectUri(value: unknown, options?: WeComLoginRedirectOptions): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || /[\s?#]/.test(value)) {
    throw new WeComRedirectUriError()
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WeComRedirectUriError()
  }
  const secure = url.protocol === 'https:'
  const loopbackHttp = url.protocol === 'http:' && options?.allowLoopbackHttp === true && isLoopbackHost(url.hostname)
  if (!secure && !loopbackHttp) throw new WeComRedirectUriError()
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.hostname === '') {
    throw new WeComRedirectUriError()
  }
  return `${url.protocol}//${url.host}${url.pathname}`
}

/** `lower(userid)` after the member-id rule; a `CorpId/userid` form or any other shape is rejected. */
export function normalizeWeComSubjectKey(userid: string): string {
  if (!isValidWeComUserId(userid)) throw new WeComInvalidInputError('userid')
  return userid.toLowerCase()
}

/**
 * The identity key of a member: the JSON array `[corpId, lower(userid)]`. The array form is
 * injective whatever characters the corp id holds, so one userid in two corporations never collides.
 */
export function buildWeComExternalKey(corpId: string, userid: string): string {
  if (!isValidWeComCorpId(corpId)) throw new WeComInvalidInputError('corpId')
  return JSON.stringify([corpId, normalizeWeComSubjectKey(userid)])
}

function assertConnection(connection: WeComIdentityConnection): void {
  if (!isValidWeComCorpId(connection.corpId)) throw new WeComInvalidInputError('corpId')
  if (!isValidWeComAgentId(connection.wecomAgentId)) throw new WeComInvalidInputError('wecomAgentId')
}

function rejected(reason: WeComIdentityRejectedReason, adminReason?: WeComIdentityAdminReason): WeComIdentityResult {
  return adminReason === undefined
    ? { ok: false, outcome: 'rejected', reason }
    : { ok: false, outcome: 'rejected', reason, adminReason }
}

function unavailable(reason: WeComIdentityUnavailableReason): WeComIdentityResult {
  return { ok: false, outcome: 'unavailable', reason }
}

function adminReasonOf(errcode: number): WeComIdentityAdminReason {
  switch (errcode) {
    case 60020:
      return 'trusted_ip'
    case 40013:
      return 'invalid_corp'
    case 40056:
      return 'invalid_agent'
    case 50001:
      return 'redirect_domain'
    default:
      return 'config_fault'
  }
}

type FailurePhase = 'login' | 'member'

/** Maps a client failure to a result. Every failure denies; a transient one is `unavailable`, never a pass. */
function resultOfFailure(error: unknown, phase: FailurePhase): WeComIdentityResult {
  if (error instanceof WeComInvalidInputError) throw error
  const tokenStage = isWeComTokenStageError(error)
  const transient = (reason: WeComIdentityUnavailableReason): WeComIdentityResult =>
    unavailable(tokenStage ? 'token_unavailable' : reason)

  if (error instanceof WeComTimeoutError) return transient('timeout')
  if (error instanceof WeComTransportError) return transient('transport')
  if (error instanceof WeComIncompleteResponseError) return transient('incomplete_response')
  if (error instanceof WeComRequestError) {
    if (error.statusCode === 429) return transient('rate_limited')
    if (error.statusCode >= 500 || error.statusCode === 408) return transient('busy')
    return tokenStage ? rejected('config_fault', 'config_fault') : rejected('provider_error')
  }
  if (error instanceof WeComBusinessError) {
    const category = classifyWeComErrcode(error.errcode)
    switch (category) {
      case 'token_stale':
        return unavailable('token_unavailable')
      case 'busy':
        return transient('busy')
      case 'rate_limited':
        return transient('rate_limited')
      case 'config_fault':
        return rejected('config_fault', adminReasonOf(error.errcode))
      case 'permission_fault':
        return rejected('permission_fault')
      default:
        break
    }
    if (tokenStage) return rejected('config_fault', 'config_fault')
    switch (category) {
      case 'scope_fault':
        return rejected('subject_out_of_scope')
      case 'subject_invalid':
        return rejected(phase === 'member' ? 'subject_unknown' : 'subject_invalid')
      case 'code_invalid':
        return rejected(phase === 'login' ? 'code_invalid' : 'provider_error')
      default:
        return rejected('provider_error')
    }
  }
  throw error
}

export interface WeComIdentityAdapterOptions {
  /** The deployment-level redirect address; validated here and never taken from a request. */
  redirectUri: string
  /** Test seams of the client (`fetchFn`, clock, sleep). */
  requestOptions?: WeComRequestOptions
  /** Accepts an `http` loopback redirect address. Only a test injects it. */
  allowLoopbackHttp?: boolean
}

export interface WeComIdentityAdapter {
  readonly provider: 'wecom'
  readonly assurance: typeof WECOM_IDENTITY_ASSURANCE
  readonly adapterRev: number
  buildAuthorizationUrl(connection: Pick<WeComIdentityConnection, 'corpId' | 'wecomAgentId'>, state: string): string
  exchangeCode(input: {
    connection: WeComIdentityConnection
    credentials: WeComIdentityCredentials
    code: string
  }): Promise<WeComIdentityResult>
}

export function createWeComIdentityAdapter(options: WeComIdentityAdapterOptions): WeComIdentityAdapter {
  const redirectUri = normalizeWeComLoginRedirectUri(options.redirectUri, { allowLoopbackHttp: options.allowLoopbackHttp })
  const requestOptions = options.requestOptions

  return {
    provider: 'wecom',
    assurance: WECOM_IDENTITY_ASSURANCE,
    adapterRev: WECOM_IDENTITY_ADAPTER_REV,

    buildAuthorizationUrl(connection, state) {
      assertConnection(connection as WeComIdentityConnection)
      if (typeof state !== 'string' || !WECOM_LOGIN_STATE_PATTERN.test(state)) throw new WeComLoginStateError()
      return `${WECOM_LOGIN_AUTHORIZE_URL}?login_type=CorpApp`
        + `&appid=${encodeURIComponent(connection.corpId)}`
        + `&agentid=${encodeURIComponent(connection.wecomAgentId)}`
        + `&redirect_uri=${encodeURIComponent(redirectUri)}`
        + `&state=${encodeURIComponent(state)}`
    },

    async exchangeCode({ connection, credentials, code }) {
      assertConnection(connection)
      if (!isValidWeComLoginCode(code)) return rejected('code_invalid')
      const tokenConfig = { corpId: connection.corpId, corpSecret: credentials.corpSecret, baseUrl: credentials.baseUrl }

      let exchanged: Awaited<ReturnType<typeof exchangeWeComLoginCode>>
      try {
        exchanged = await exchangeWeComLoginCode(tokenConfig, code, requestOptions)
      } catch (error) {
        return resultOfFailure(error, 'login')
      }
      if (exchanged.kind !== 'member') return rejected('subject_not_member')
      const providerUserId = exchanged.userid
      if (!isValidWeComUserId(providerUserId)) return rejected('subject_invalid')

      let member: Awaited<ReturnType<typeof getWeComMember>>
      try {
        member = await getWeComMember(tokenConfig, providerUserId, requestOptions)
      } catch (error) {
        return resultOfFailure(error, 'member')
      }
      if (member.userid.toLowerCase() !== providerUserId.toLowerCase()) return rejected('subject_unknown')
      if (member.status !== 1) return rejected('subject_inactive')

      return {
        ok: true,
        subject: {
          provider: 'wecom',
          connectionId: connection.id,
          tenant: connection.corpId,
          appScope: connection.wecomAgentId,
          subjectType: 'wecom_userid',
          subjectKey: normalizeWeComSubjectKey(providerUserId),
          providerUserId,
          memberVerification: 'online_verified',
        },
      }
    },
  }
}
