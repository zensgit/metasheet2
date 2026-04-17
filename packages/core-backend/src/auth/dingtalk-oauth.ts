import crypto from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import Redis from 'ioredis'
import { Logger } from '../core/logger'
import { query, transaction } from '../db/pg'
import {
  exchangeCodeForUserAccessToken,
  fetchDingTalkCurrentUser,
  readDingTalkOauthConfig,
} from '../integrations/dingtalk/client'
import {
  assertDingTalkCorpAllowed,
  DingTalkCorpNotAllowedError,
  readDingTalkAllowedCorpIds,
} from '../integrations/dingtalk/runtime-policy'
import { getBcryptSaltRounds } from '../security/auth-runtime-config'

const logger = new Logger('DingTalkOAuth')

const PROVIDER = 'dingtalk'
const STATE_TTL_MS = 5 * 60 * 1000
const MAX_PENDING_STATES = 10_000
const STATE_REDIS_RETENTION_MS = 60 * 1000
const STATE_REDIS_KEY_PREFIX = 'metasheet:auth:dingtalk:state:'
const STATE_REDIS_INDEX_KEY = 'metasheet:auth:dingtalk:state:index'
const DINGTALK_LOGIN_DISABLED_ERROR = 'DingTalk login is disabled for this user'

export interface DingTalkUserInfo {
  openId: string
  unionId: string
  nick: string
  email?: string
  mobile?: string
  avatarUrl?: string
}

export interface DingTalkExchangeResult {
  dingtalkUser: DingTalkUserInfo
  localUserId: string
  localUserEmail: string
  localUserName: string
  localUserRole: string
  isNewUser: boolean
}

interface LocalUserRow {
  id: string
  email: string
  name: string
  role: string
  is_active: boolean
}

export type DingTalkOAuthIntent = 'login' | 'bind'

interface StateRecord {
  expiresAt: number
  redirectPath?: string
  intent?: DingTalkOAuthIntent
  bindUserId?: string
}

export interface StateValidationResult {
  valid: boolean
  error?: string
  redirectPath?: string
  intent?: DingTalkOAuthIntent
  bindUserId?: string
}

export type DingTalkRuntimeUnavailableReason =
  | 'missing_client_id'
  | 'missing_client_secret'
  | 'missing_redirect_uri'
  | 'corp_not_allowed'
  | null

export interface DingTalkRuntimeStatus {
  configured: boolean
  available: boolean
  corpId: string | null
  allowedCorpIds: string[]
  requireGrant: boolean
  autoLinkEmail: boolean
  autoProvision: boolean
  unavailableReason: DingTalkRuntimeUnavailableReason
}

export class DingTalkLoginPolicyError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(message: string, options: { statusCode?: number; code?: string } = {}) {
    super(message)
    this.name = 'DingTalkLoginPolicyError'
    this.statusCode = options.statusCode ?? 403
    this.code = options.code ?? 'policy_denied'
  }
}

const pendingStates = new Map<string, StateRecord>()
let redisStateClient: Redis | null = null
let redisStateClientPromise: Promise<Redis | null> | null = null
let redisFallbackLogged = false

function createPolicyError(
  message: string,
  options: { statusCode?: number; code?: string } = {},
): DingTalkLoginPolicyError {
  return new DingTalkLoginPolicyError(message, options)
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] ?? '').trim().toLowerCase()
  if (!raw) return fallback
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(raw)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(raw)) return false
  return fallback
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

function shouldAutoLinkEmail(): boolean {
  return parseBooleanEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', false)
}

function shouldAutoProvision(): boolean {
  return parseBooleanEnv('DINGTALK_AUTH_AUTO_PROVISION', false)
}

function shouldRequireGrant(): boolean {
  return parseBooleanEnv('DINGTALK_AUTH_REQUIRE_GRANT', false)
}

function buildRedisUrl(): string | null {
  const explicitUrl = process.env.REDIS_URL?.trim()
  if (explicitUrl) return explicitUrl

  const host = process.env.REDIS_HOST?.trim()
  if (!host) return null

  const port = process.env.REDIS_PORT?.trim() || '6379'
  const password = process.env.REDIS_PASSWORD?.trim()
  if (password) {
    return `redis://:${encodeURIComponent(password)}@${host}:${port}`
  }
  return `redis://${host}:${port}`
}

function stateRedisKey(state: string): string {
  return `${STATE_REDIS_KEY_PREFIX}${state}`
}

function buildExternalKey(dtUser: DingTalkUserInfo): string {
  const config = readDingTalkOauthConfig()
  if (config.corpId) {
    return `${config.corpId}:${dtUser.openId}`
  }
  return dtUser.unionId || dtUser.openId
}

function pruneExpiredStates(): void {
  const now = Date.now()
  for (const [key, record] of pendingStates) {
    if (record.expiresAt <= now) pendingStates.delete(key)
  }
}

function logRedisFallback(reason: string, error?: unknown): void {
  if (redisFallbackLogged) return
  redisFallbackLogged = true
  logger.warn(
    `Falling back to in-memory DingTalk OAuth state store: ${reason}${error instanceof Error ? ` (${error.message})` : ''}`,
  )
}

async function getRedisStateClient(): Promise<Redis | null> {
  if (redisStateClient) return redisStateClient
  if (redisStateClientPromise) return redisStateClientPromise

  const redisUrl = buildRedisUrl()
  if (!redisUrl) return null

  redisStateClientPromise = (async () => {
    try {
      const client = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      })

      client.on('error', (error) => {
        logRedisFallback('Redis state store connection error', error)
        if (redisStateClient === client) {
          redisStateClient = null
        }
      })
      client.on('end', () => {
        if (redisStateClient === client) {
          redisStateClient = null
        }
      })

      await client.connect()
      redisFallbackLogged = false
      redisStateClient = client
      return client
    } catch (error) {
      logRedisFallback('Redis state store unavailable', error)
      return null
    } finally {
      redisStateClientPromise = null
    }
  })()

  return redisStateClientPromise
}

async function invalidateRedisStateClient(client: Redis | null): Promise<void> {
  if (!client) return
  if (redisStateClient === client) {
    redisStateClient = null
  }
  try {
    await client.quit()
  } catch {
    client.disconnect()
  }
}

async function pruneRedisStateIndex(client: Redis, now: number): Promise<void> {
  const expiredStateIds = await client.zrangebyscore(STATE_REDIS_INDEX_KEY, 0, now)
  if (expiredStateIds.length === 0) return

  const keys = expiredStateIds.map((state) => stateRedisKey(state))
  const cleanup = client.multi()
  cleanup.del(...keys)
  cleanup.zrem(STATE_REDIS_INDEX_KEY, ...expiredStateIds)
  await cleanup.exec()
}

async function trimRedisStateIndex(client: Redis): Promise<void> {
  const count = await client.zcard(STATE_REDIS_INDEX_KEY)
  if (count < MAX_PENDING_STATES) return

  const overflow = count - MAX_PENDING_STATES + 1
  const oldestStateIds = await client.zrange(STATE_REDIS_INDEX_KEY, 0, overflow - 1)
  if (oldestStateIds.length === 0) return

  const keys = oldestStateIds.map((state) => stateRedisKey(state))
  const cleanup = client.multi()
  cleanup.del(...keys)
  cleanup.zrem(STATE_REDIS_INDEX_KEY, ...oldestStateIds)
  await cleanup.exec()
}

async function writeStateToRedis(state: string, record: StateRecord): Promise<boolean> {
  const client = await getRedisStateClient()
  if (!client) return false

  try {
    await pruneRedisStateIndex(client, Date.now())
    await trimRedisStateIndex(client)

    const ttlMs = Math.max(record.expiresAt - Date.now() + STATE_REDIS_RETENTION_MS, STATE_REDIS_RETENTION_MS)
    const results = await client.multi()
      .set(stateRedisKey(state), JSON.stringify(record), 'PX', ttlMs)
      .zadd(STATE_REDIS_INDEX_KEY, record.expiresAt, state)
      .exec()

    if (!results || results.some(([error]) => error)) {
      logRedisFallback('Redis state write failed', results)
      await invalidateRedisStateClient(client)
      return false
    }
    return true
  } catch (error) {
    logRedisFallback('Redis state write failed', error)
    await invalidateRedisStateClient(client)
    return false
  }
}

async function validateStateFromRedis(state: string): Promise<StateValidationResult | null> {
  const client = await getRedisStateClient()
  if (!client) return null

  try {
    const results = await client.multi()
      .get(stateRedisKey(state))
      .del(stateRedisKey(state))
      .zrem(STATE_REDIS_INDEX_KEY, state)
      .exec()

    if (!results || results.some(([error]) => error)) {
      logRedisFallback('Redis state validation failed', results)
      await invalidateRedisStateClient(client)
      return null
    }

    const statePayload = results?.[0]?.[1]
    if (typeof statePayload !== 'string') {
      return { valid: false, error: 'Invalid or unknown state parameter' }
    }

    let parsed: StateRecord | null = null
    try {
      parsed = JSON.parse(statePayload) as StateRecord
    } catch {
      parsed = null
    }

    if (!parsed || typeof parsed.expiresAt !== 'number') {
      return { valid: false, error: 'Invalid or unknown state parameter' }
    }

    if (Date.now() > parsed.expiresAt) {
      return { valid: false, error: 'State parameter has expired' }
    }

    return {
      valid: true,
      redirectPath: parsed.redirectPath,
      intent: parsed.intent,
      bindUserId: parsed.bindUserId,
    }
  } catch (error) {
    logRedisFallback('Redis state validation failed', error)
    await invalidateRedisStateClient(client)
    return null
  }
}

function writeStateToMemory(state: string, record: StateRecord): void {
  pruneExpiredStates()
  if (pendingStates.size >= MAX_PENDING_STATES) {
    const oldest = pendingStates.keys().next().value
    if (oldest) pendingStates.delete(oldest)
  }
  pendingStates.set(state, record)
}

function validateStateFromMemory(state: string): StateValidationResult {
  const record = pendingStates.get(state)
  if (!record) return { valid: false, error: 'Invalid or unknown state parameter' }
  pendingStates.delete(state)

  if (Date.now() > record.expiresAt) {
    return { valid: false, error: 'State parameter has expired' }
  }

  return {
    valid: true,
    redirectPath: record.redirectPath,
    intent: record.intent,
    bindUserId: record.bindUserId,
  }
}

async function readGrantEnabled(localUserId: string): Promise<boolean | null> {
  try {
    const result = await query<{ enabled: boolean }>(
      `SELECT enabled
       FROM user_external_auth_grants
       WHERE provider = $1 AND local_user_id = $2
       LIMIT 1`,
      [PROVIDER, localUserId],
    )
    if (result.rows.length === 0) return null
    return result.rows[0]?.enabled === true
  } catch (error) {
    logger.warn('Failed to read DingTalk auth grant; treating as optional', error instanceof Error ? error : undefined)
    return null
  }
}

async function ensureGrant(localUserId: string): Promise<void> {
  try {
    await query(
      `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by, created_at, updated_at)
       VALUES ($1, $2, TRUE, $3, NOW(), NOW())
       ON CONFLICT (provider, local_user_id) DO NOTHING`,
      [PROVIDER, localUserId, localUserId],
    )
  } catch (error) {
    logger.warn('Failed to persist DingTalk auth grant', error instanceof Error ? error : undefined)
  }
}

async function upsertExternalIdentity(localUserId: string, dtUser: DingTalkUserInfo): Promise<void> {
  const config = readDingTalkOauthConfig()
  const externalKey = buildExternalKey(dtUser)
  const profile = JSON.stringify(dtUser)

  await transaction(async (client) => {
    const existingByUser = await client.query(
      `SELECT id
       FROM user_external_identities
       WHERE provider = $1 AND local_user_id = $2
       LIMIT 1`,
      [PROVIDER, localUserId],
    )

    if (existingByUser.rows.length > 0) {
      await client.query(
        `UPDATE user_external_identities
         SET external_key = $3,
             provider_union_id = $4,
             provider_open_id = $5,
             corp_id = $6,
             profile = $7::jsonb,
             bound_by = COALESCE(bound_by, $2),
             last_login_at = NOW(),
             updated_at = NOW()
         WHERE provider = $1 AND local_user_id = $2`,
        [PROVIDER, localUserId, externalKey, dtUser.unionId || null, dtUser.openId, config.corpId, profile],
      )
      return
    }

    await client.query(
      `INSERT INTO user_external_identities (
         provider,
         external_key,
         provider_union_id,
         provider_open_id,
         corp_id,
         local_user_id,
         profile,
         bound_by,
         last_login_at,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $6, NOW(), NOW(), NOW())
       ON CONFLICT (provider, external_key)
       DO UPDATE SET
         provider_union_id = EXCLUDED.provider_union_id,
         provider_open_id = EXCLUDED.provider_open_id,
         corp_id = EXCLUDED.corp_id,
         local_user_id = EXCLUDED.local_user_id,
         profile = EXCLUDED.profile,
         bound_by = COALESCE(user_external_identities.bound_by, EXCLUDED.bound_by),
         last_login_at = NOW(),
         updated_at = NOW()`,
      [PROVIDER, externalKey, dtUser.unionId || null, dtUser.openId, config.corpId, localUserId, profile],
    )
  })
}

async function findUserByEmail(email: string): Promise<LocalUserRow | null> {
  const result = await query<LocalUserRow>(
    `SELECT id,
            email,
            COALESCE(name, '') AS name,
            COALESCE(role, 'user') AS role,
            COALESCE(is_active, TRUE) AS is_active
     FROM users
     WHERE LOWER(email) = LOWER($1)
     LIMIT 1`,
    [email],
  )
  return result.rows[0] ?? null
}

async function findIdentityUser(dtUser: DingTalkUserInfo): Promise<LocalUserRow | null> {
  try {
    const config = readDingTalkOauthConfig()
    const result = await query<LocalUserRow>(
      `SELECT u.id,
              u.email,
              COALESCE(u.name, '') AS name,
              COALESCE(u.role, 'user') AS role,
              COALESCE(u.is_active, TRUE) AS is_active
       FROM user_external_identities identity
       JOIN users u ON u.id = identity.local_user_id
       WHERE identity.provider = $1
         AND (
           identity.external_key = $2
           OR (
             $5 = ''
             AND (
               identity.provider_open_id = $3
               OR ($4 <> '' AND identity.provider_union_id = $4)
             )
           )
           OR (
             $5 <> ''
             AND identity.corp_id = $5
             AND (
               identity.provider_open_id = $3
               OR ($4 <> '' AND identity.provider_union_id = $4)
             )
           )
         )
       ORDER BY identity.updated_at DESC
       LIMIT 1`,
      [PROVIDER, buildExternalKey(dtUser), dtUser.openId, dtUser.unionId || '', config.corpId || ''],
    )
    return result.rows[0] ?? null
  } catch (error) {
    logger.warn('Failed to resolve DingTalk external identity', error instanceof Error ? error : undefined)
    return null
  }
}

function assertLocalUserLoginAllowed(localUser: LocalUserRow): void {
  if (localUser.role === 'disabled' || localUser.is_active === false) {
    throw createPolicyError(DINGTALK_LOGIN_DISABLED_ERROR, {
      statusCode: 403,
      code: 'local_user_disabled',
    })
  }
}

async function createProvisionedUser(dtUser: DingTalkUserInfo): Promise<LocalUserRow> {
  const userId = crypto.randomUUID()
  const email = dtUser.email || `dingtalk_${dtUser.openId}@placeholder.local`
  const name = dtUser.nick || 'DingTalk User'
  const passwordHash = await bcrypt.hash(
    crypto.randomBytes(32).toString('base64url'),
    getBcryptSaltRounds(),
  )

  if (dtUser.email) {
    const existingUser = await findUserByEmail(dtUser.email)
    if (existingUser) {
      throw createPolicyError(
        'Refusing to auto-provision DingTalk user because a local account already exists with the same email',
        {
          statusCode: 409,
          code: 'auto_provision_email_conflict',
        },
      )
    }
  }

  try {
    const result = await query<LocalUserRow>(
      `INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'user', NOW(), NOW())
       RETURNING id,
                 email,
                 COALESCE(name, '') AS name,
                 COALESCE(role, 'user') AS role,
                 COALESCE(is_active, TRUE) AS is_active`,
      [userId, email, name, passwordHash],
    )

    const row = result.rows[0]
    if (!row) {
      throw new Error('Failed to create local user for DingTalk login')
    }
    return row
  } catch (error) {
    if (
      dtUser.email &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    ) {
      throw createPolicyError(
        'Refusing to auto-provision DingTalk user because a local account already exists with the same email',
        {
          statusCode: 409,
          code: 'auto_provision_email_conflict',
        },
      )
    }
    throw error
  }
}

async function resolveLocalUser(dtUser: DingTalkUserInfo): Promise<{ localUser: LocalUserRow; isNewUser: boolean }> {
  const requireGrant = shouldRequireGrant()
  const identityUser = await findIdentityUser(dtUser)
  if (identityUser) {
    assertLocalUserLoginAllowed(identityUser)
    const grantEnabled = await readGrantEnabled(identityUser.id)
    if (requireGrant && grantEnabled !== true) {
      throw new Error('DingTalk login is not enabled for this user')
    }
    if (grantEnabled === false) {
      throw createPolicyError(DINGTALK_LOGIN_DISABLED_ERROR, {
        statusCode: 403,
        code: 'grant_disabled',
      })
    }
    await upsertExternalIdentity(identityUser.id, dtUser)
    return { localUser: identityUser, isNewUser: false }
  }

  if (dtUser.email && shouldAutoLinkEmail()) {
    const emailUser = await findUserByEmail(dtUser.email)
    if (emailUser) {
      assertLocalUserLoginAllowed(emailUser)
      const grantEnabled = await readGrantEnabled(emailUser.id)
      if (requireGrant && grantEnabled !== true) {
        throw new Error('DingTalk login is not enabled for this user')
      }
      if (grantEnabled === false) {
        throw createPolicyError(DINGTALK_LOGIN_DISABLED_ERROR, {
          statusCode: 403,
          code: 'grant_disabled',
        })
      }
      if (!requireGrant) {
        await ensureGrant(emailUser.id)
      }
      await upsertExternalIdentity(emailUser.id, dtUser)
      return { localUser: emailUser, isNewUser: false }
    }
  }

  if (requireGrant) {
    throw new Error(
      dtUser.email
        ? `DingTalk account ${dtUser.email} is not linked to an enabled local user`
        : 'DingTalk account is not linked to an enabled local user',
    )
  }

  if (!shouldAutoProvision()) {
    throw createPolicyError(
      dtUser.email
        ? `DingTalk account ${dtUser.email} is not linked to a local user`
        : 'DingTalk account is not linked to a local user',
      {
        statusCode: 403,
        code: 'unlinked_local_user',
      },
    )
  }

  const provisionedUser = await createProvisionedUser(dtUser)
  await ensureGrant(provisionedUser.id)
  await upsertExternalIdentity(provisionedUser.id, dtUser)
  return { localUser: provisionedUser, isNewUser: true }
}

export function isDingTalkConfigured(): boolean {
  return getDingTalkRuntimeStatus().available
}

export function getDingTalkRuntimeStatus(): DingTalkRuntimeStatus {
  const clientId = readStringEnv('DINGTALK_CLIENT_ID', 'DINGTALK_APP_KEY')
  const clientSecret = readStringEnv('DINGTALK_CLIENT_SECRET', 'DINGTALK_APP_SECRET')
  const redirectUri = readStringEnv('DINGTALK_REDIRECT_URI')
  const corpId = readStringEnv('DINGTALK_CORP_ID') || null
  const allowedCorpIds = readDingTalkAllowedCorpIds()

  let unavailableReason: DingTalkRuntimeUnavailableReason = null
  if (!clientId) {
    unavailableReason = 'missing_client_id'
  } else if (!clientSecret) {
    unavailableReason = 'missing_client_secret'
  } else if (!redirectUri) {
    unavailableReason = 'missing_redirect_uri'
  } else {
    try {
      assertDingTalkCorpAllowed(corpId, {
        allowEmpty: true,
        context: 'DINGTALK_CORP_ID',
      })
    } catch (error) {
      if (error instanceof DingTalkCorpNotAllowedError) {
        unavailableReason = 'corp_not_allowed'
      } else {
        unavailableReason = 'corp_not_allowed'
      }
    }
  }

  return {
    configured: Boolean(clientId && clientSecret && redirectUri),
    available: unavailableReason === null,
    corpId,
    allowedCorpIds,
    requireGrant: shouldRequireGrant(),
    autoLinkEmail: shouldAutoLinkEmail(),
    autoProvision: shouldAutoProvision(),
    unavailableReason,
  }
}

export async function generateState(options: {
  redirectPath?: string | null
  intent?: DingTalkOAuthIntent | null
  bindUserId?: string | null
} = {}): Promise<string> {
  const state = crypto.randomUUID()
  const normalizedIntent = options.intent === 'bind' ? 'bind' : null
  const normalizedBindUserId = typeof options.bindUserId === 'string' && options.bindUserId.trim().length > 0
    ? options.bindUserId.trim()
    : null
  const record: StateRecord = {
    expiresAt: Date.now() + STATE_TTL_MS,
    ...(typeof options.redirectPath === 'string' && options.redirectPath.trim().length > 0
      ? { redirectPath: options.redirectPath.trim() }
      : {}),
    ...(normalizedIntent ? { intent: normalizedIntent } : {}),
    ...(normalizedIntent === 'bind' && normalizedBindUserId ? { bindUserId: normalizedBindUserId } : {}),
  }

  const storedInRedis = await writeStateToRedis(state, record)
  if (!storedInRedis) {
    writeStateToMemory(state, record)
  }

  return state
}

export async function validateState(state: string): Promise<StateValidationResult> {
  if (!state) return { valid: false, error: 'Missing required parameter: state' }

  const redisResult = await validateStateFromRedis(state)
  if (redisResult?.valid) return redisResult
  if (redisResult?.error === 'State parameter has expired') return redisResult

  return validateStateFromMemory(state)
}

export async function __resetDingTalkOAuthStateStoreForTests(): Promise<void> {
  pendingStates.clear()
  redisFallbackLogged = false
  const client = redisStateClient
  redisStateClient = null
  redisStateClientPromise = null
  await invalidateRedisStateClient(client)
}

export function buildAuthUrl(state: string): string {
  const config = readDingTalkOauthConfig()
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid',
    state,
    prompt: 'consent',
  })
  return `https://login.dingtalk.com/oauth2/auth?${params.toString()}`
}

export async function exchangeCodeForDingTalkProfile(code: string): Promise<DingTalkUserInfo> {
  const token = await exchangeCodeForUserAccessToken(code)
  const profile = await fetchDingTalkCurrentUser(token.accessToken)
  return {
    openId: profile.openId,
    unionId: profile.unionId,
    nick: profile.nick,
    email: profile.email,
    mobile: profile.mobile,
    avatarUrl: profile.avatarUrl,
  }
}

export async function exchangeCodeForUser(code: string): Promise<DingTalkExchangeResult> {
  const dingtalkUser = await exchangeCodeForDingTalkProfile(code)
  const { localUser, isNewUser } = await resolveLocalUser(dingtalkUser)

  return {
    dingtalkUser,
    localUserId: localUser.id,
    localUserEmail: localUser.email,
    localUserName: localUser.name,
    localUserRole: localUser.role,
    isNewUser,
  }
}

export async function bindDingTalkIdentityToUser(input: {
  localUserId: string
  dtUser: DingTalkUserInfo
  boundBy?: string
  enableGrant?: boolean
}): Promise<void> {
  const { localUserId, dtUser, enableGrant } = input
  const boundBy = typeof input.boundBy === 'string' && input.boundBy.trim().length > 0
    ? input.boundBy.trim()
    : localUserId

  const config = readDingTalkOauthConfig()
  const externalKey = buildExternalKey(dtUser)
  const profile = JSON.stringify(dtUser)
  const openId = dtUser.openId || ''
  const unionId = dtUser.unionId || ''

  await transaction(async (client) => {
    const conflictResult = await client.query(
      `SELECT local_user_id
       FROM user_external_identities
       WHERE provider = $1
         AND local_user_id <> $2
         AND (
           external_key = $3
           OR ($4 <> '' AND provider_open_id = $4 AND corp_id IS NOT DISTINCT FROM $6)
           OR ($5 <> '' AND provider_union_id = $5 AND corp_id IS NOT DISTINCT FROM $6)
         )
       LIMIT 1`,
      [PROVIDER, localUserId, externalKey, openId, unionId, config.corpId || null],
    )
    if (conflictResult.rows.length > 0) {
      throw createPolicyError('DingTalk identity is already bound to another local user', {
        statusCode: 409,
        code: 'identity_already_bound',
      })
    }

    const existingByUser = await client.query(
      `SELECT id
       FROM user_external_identities
       WHERE provider = $1 AND local_user_id = $2
       LIMIT 1`,
      [PROVIDER, localUserId],
    )

    if (existingByUser.rows.length > 0) {
      await client.query(
        `UPDATE user_external_identities
         SET external_key = $3,
             provider_union_id = $4,
             provider_open_id = $5,
             corp_id = $6,
             profile = $7::jsonb,
             bound_by = COALESCE(bound_by, $8),
             updated_at = NOW()
         WHERE provider = $1 AND local_user_id = $2`,
        [PROVIDER, localUserId, externalKey, dtUser.unionId || null, dtUser.openId, config.corpId, profile, boundBy],
      )
    } else {
      await client.query(
        `INSERT INTO user_external_identities (
           provider,
           external_key,
           provider_union_id,
           provider_open_id,
           corp_id,
           local_user_id,
           profile,
           bound_by,
           created_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW())`,
        [PROVIDER, externalKey, dtUser.unionId || null, dtUser.openId, config.corpId, localUserId, profile, boundBy],
      )
    }

    if (enableGrant) {
      await client.query(
        `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by, created_at, updated_at)
         VALUES ($1, $2, TRUE, $3, NOW(), NOW())
         ON CONFLICT (provider, local_user_id)
         DO UPDATE SET enabled = TRUE, granted_by = EXCLUDED.granted_by, updated_at = NOW()`,
        [PROVIDER, localUserId, boundBy],
      )
    }
  })
}
