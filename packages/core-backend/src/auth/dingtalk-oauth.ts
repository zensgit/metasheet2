import crypto from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import Redis from 'ioredis'
import { Logger } from '../core/logger'
import { query, transaction } from '../db/pg'
import {
  exchangeCodeForUserAccessToken,
  fetchDingTalkAppAccessToken,
  fetchDingTalkCurrentUser,
  getDingTalkUserDetail,
  getDingTalkUserInfoByAuthCode,
  readDingTalkOauthConfig,
} from '../integrations/dingtalk/client'
import {
  assertDingTalkCorpAllowed,
  DingTalkCorpNotAllowedError,
  isCorpAllowlistConfigured,
  readDingTalkAllowedCorpIds,
} from '../integrations/dingtalk/runtime-policy'
import { getBcryptSaltRounds } from '../security/auth-runtime-config'
import { evaluateUserAuthenticationGate } from './user-activation'
import {
  claimNonEmptyLoginAliasesOrThrow,
  LoginAliasClaimError,
} from './login-alias-service'
import { recordDingTalkOAuthStateFallback, recordDingTalkOAuthStateOperation } from '../metrics/metrics'
import {
  lockUsersForAccessGraphWrite,
  supersedeDeprovisionEvidenceForAccessGraphWrite,
} from '../directory/access-graph-mutex'

/** JIT placeholder email is not a login identifier — never claim it as an alias. */
function isDingTalkPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return true
  return /@placeholder\.local$/i.test(email.trim())
}

const logger = new Logger('DingTalkOAuth')

const PROVIDER = 'dingtalk'
const STATE_TTL_MS = 5 * 60 * 1000
const MAX_PENDING_STATES = 10_000
const STATE_REDIS_RETENTION_MS = 60 * 1000
const STATE_REDIS_KEY_PREFIX = 'metasheet:auth:dingtalk:state:'
const STATE_REDIS_INDEX_KEY = 'metasheet:auth:dingtalk:state:index'
const DINGTALK_LOGIN_DISABLED_ERROR = 'DingTalk login is disabled for this user'

export interface DingTalkUserInfo {
  /** sns openId (web-OAuth). Absent on the E1 container surface — the
   *  enterprise 免登 chain only yields corp userid + unionId. */
  openId?: string
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
  activation_status?: string | null
}

export type DingTalkOAuthIntent = 'login' | 'bind' | 'activate'

interface StateRecord {
  expiresAt: number
  redirectPath?: string
  intent?: DingTalkOAuthIntent
  bindUserId?: string
  activateUserId?: string
  activateAdminUserId?: string
}

export interface StateValidationResult {
  valid: boolean
  error?: string
  redirectPath?: string
  intent?: DingTalkOAuthIntent
  bindUserId?: string
  activateUserId?: string
  activateAdminUserId?: string
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

/**
 * DT-OPS-05 — the OAuth `state` store and multi-replica deployments.
 *
 * `state` proves the callback belongs to a launch we issued, and is single-use. It lives
 * in Redis when configured and otherwise in an in-process Map. That Map is fine for a
 * single replica and quietly wrong for more than one: the callback can land on a
 * different instance than the launch (valid state rejected → login fails), one-time-use
 * is only guaranteed per process, and a transient Redis outage silently degrades to it.
 *
 * Deployments that run more than one replica set this flag and fail closed instead.
 * Default off: single-replica behavior is unchanged.
 */
export function isDingTalkOAuthSharedStateStoreRequired(): boolean {
  return ['true', '1', 'yes'].includes(
    String(process.env.DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE ?? '').trim().toLowerCase(),
  )
}

export class DingTalkOAuthStateStoreUnavailableError extends Error {
  readonly statusCode = 503
  readonly code = 'DINGTALK_STATE_STORE_UNAVAILABLE'

  constructor() {
    super('DingTalk OAuth state store (Redis) is unavailable and a shared store is required')
    this.name = 'DingTalkOAuthStateStoreUnavailableError'
  }
}
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
  // openId when present (web-OAuth, unchanged); unionId fallback for the E1
  // container surface (e1-container-login design-lock §2).
  const primaryId = dtUser.openId || dtUser.unionId
  if (config.corpId) {
    return `${config.corpId}:${primaryId}`
  }
  return dtUser.unionId || dtUser.openId || ''
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

    if (!parsed || typeof parsed.expiresAt !== 'number' || !isValidStateRecord(parsed)) {
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
      activateUserId: parsed.activateUserId,
      activateAdminUserId: parsed.activateAdminUserId,
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

  if (!isValidStateRecord(record)) {
    return { valid: false, error: 'Invalid or unknown state parameter' }
  }

  if (Date.now() > record.expiresAt) {
    return { valid: false, error: 'State parameter has expired' }
  }

  return {
    valid: true,
    redirectPath: record.redirectPath,
    intent: record.intent,
    bindUserId: record.bindUserId,
    activateUserId: record.activateUserId,
    activateAdminUserId: record.activateAdminUserId,
  }
}

function isNonEmptyStateId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isValidStateRecord(record: StateRecord): boolean {
  const intent = record.intent
  if (intent === undefined || intent === 'login') {
    return !record.bindUserId && !record.activateUserId && !record.activateAdminUserId
  }
  if (intent === 'bind') {
    return (
      isNonEmptyStateId(record.bindUserId)
      && !record.activateUserId
      && !record.activateAdminUserId
    )
  }
  if (intent === 'activate') {
    return (
      !record.bindUserId
      && isNonEmptyStateId(record.activateUserId)
      && isNonEmptyStateId(record.activateAdminUserId)
    )
  }
  return false
}

/**
 * Grant read state — TRI-STATE ON PURPOSE.
 *
 * The prior `boolean | null` shape collapsed three genuinely different states — `enabled`,
 * explicitly `disabled`, and `absent` (no row) — into two, and its catch returned `null`, the
 * SAME value as "no row". So a transient query failure was indistinguishable from "this user
 * has no grant", and the deny gate below (`state === 'disabled'`) fell through: a deprovisioned
 * user's Rev 4.4 explicit disabled row could be bypassed by a single failed read while
 * DINGTALK_AUTH_REQUIRE_GRANT is off (its default). Post-merge review 2026-08-10 P1.
 *
 * A read failure now FAILS CLOSED (throws a policy error → login denied), because "we could not
 * verify the grant" must never be treated as "the grant permits login". `absent` stays a
 * distinct, allowed state: brand-new / auto-linked users legitimately have no row and must
 * still log in under the default non-strict mode.
 */
type GrantReadState = 'enabled' | 'disabled' | 'absent'

async function readGrantState(localUserId: string): Promise<GrantReadState> {
  let result: { rows: Array<{ enabled: boolean }> }
  try {
    result = await query<{ enabled: boolean }>(
      `SELECT enabled
       FROM user_external_auth_grants
       WHERE provider = $1 AND local_user_id = $2
       LIMIT 1`,
      [PROVIDER, localUserId],
    )
  } catch (error) {
    logger.warn(
      'Failed to read DingTalk auth grant; failing closed',
      error instanceof Error ? error : undefined,
    )
    throw createPolicyError(
      'Unable to verify DingTalk login authorization; please retry',
      { statusCode: 503, code: 'grant_state_unavailable' },
    )
  }
  if (result.rows.length === 0) return 'absent'
  return result.rows[0]?.enabled === true ? 'enabled' : 'disabled'
}

/**
 * Creation-only ON PURPOSE (`DO NOTHING`, never `DO UPDATE enabled=TRUE`): an existing DISABLED
 * row is deprovision's authoritative "this person was offboarded" mark — the OPS-01 writer
 * leaves it precisely so a later OAuth attempt CANNOT silently re-grant (D5 review P2: the
 * DO UPDATE variant flipped a deprovision-written enabled=false back to true on next login).
 * Re-enabling after deprovision is exclusively the audited rehire/force-restore path. A
 * genuinely NEW grant (row created, RETURNING non-empty) IS an access-graph write, so it takes
 * the mutex and supersedes open deprovision evidence (§5.4 both legs) below.
 */
async function ensureGrant(localUserId: string): Promise<void> {
  await transaction(async (client) => {
    const lockedUsers = await lockUsersForAccessGraphWrite(client, [localUserId])
    if (!lockedUsers.has(localUserId)) {
      throw createPolicyError('Local user no longer exists', {
        statusCode: 403,
        code: 'local_user_disabled',
      })
    }
    const grant = await client.query(
      `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by, created_at, updated_at)
       VALUES ($1, $2, TRUE, $3, NOW(), NOW())
       ON CONFLICT (provider, local_user_id)
       DO NOTHING
       RETURNING local_user_id`,
      [PROVIDER, localUserId, localUserId],
    )
    if (grant.rows.length > 0) {
      await supersedeDeprovisionEvidenceForAccessGraphWrite(client, {
        userIds: [localUserId],
        actorId: localUserId,
        reason: 'DingTalk OAuth enabled the user grant',
      })
    }
  })
}

async function upsertExternalIdentity(localUserId: string, dtUser: DingTalkUserInfo): Promise<void> {
  const config = readDingTalkOauthConfig()
  const externalKey = buildExternalKey(dtUser)
  const profile = JSON.stringify(dtUser)

  await transaction(async (client) => {
    const lockedUsers = await lockUsersForAccessGraphWrite(client, [localUserId])
    if (!lockedUsers.has(localUserId)) {
      throw createPolicyError('Local user no longer exists', {
        statusCode: 403,
        code: 'local_user_disabled',
      })
    }
    const existingByUser = await client.query(
      `SELECT id,
              external_key,
              provider_union_id,
              provider_open_id,
              corp_id
       FROM user_external_identities
       WHERE provider = $1 AND local_user_id = $2
       FOR UPDATE
       LIMIT 1`,
      [PROVIDER, localUserId],
    )

    let accessGraphChanged = false
    if (existingByUser.rows.length > 0) {
      // E1 (container-login design-lock §2): the container surface carries no
      // sns openId, so a container login must never clobber the openId-derived
      // external_key/provider_open_id written by web-OAuth — those columns only
      // move when the incoming profile actually has an openId (one-way
      // enrichment; alternating logins stay stable).
      const hasOpenId = Boolean(dtUser.openId)
      const existing = existingByUser.rows[0]
      const nextExternalKey = hasOpenId
        ? externalKey
        : String(existing.external_key ?? '').trim() || externalKey
      const nextUnionId =
        dtUser.unionId || existing.provider_union_id || null
      const nextOpenId = hasOpenId
        ? dtUser.openId || null
        : existing.provider_open_id || null
      const nextCorpId = hasOpenId
        ? config.corpId || null
        : existing.corp_id ?? config.corpId ?? null
      accessGraphChanged =
        (existing.external_key || '') !== nextExternalKey
        || (existing.provider_union_id ?? null) !== nextUnionId
        || (existing.provider_open_id ?? null) !== nextOpenId
        || (existing.corp_id ?? null) !== nextCorpId
      await client.query(
        `UPDATE user_external_identities
         SET external_key = CASE WHEN $8::boolean THEN $3 ELSE COALESCE(NULLIF(external_key, ''), $3) END,
             provider_union_id = COALESCE($4, provider_union_id),
             provider_open_id = CASE WHEN $8::boolean THEN $5 ELSE provider_open_id END,
             corp_id = CASE WHEN $8::boolean THEN $6 ELSE COALESCE(corp_id, $6) END,
             profile = $7::jsonb,
             bound_by = COALESCE(bound_by, $2),
             last_login_at = NOW(),
             updated_at = NOW()
         WHERE provider = $1 AND local_user_id = $2`,
        [PROVIDER, localUserId, externalKey, dtUser.unionId || null, dtUser.openId ?? null, config.corpId, profile, hasOpenId],
      )
    } else {
      const inserted = await client.query(
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
         ON CONFLICT (provider, external_key) DO NOTHING
         RETURNING id`,
        [PROVIDER, externalKey, dtUser.unionId || null, dtUser.openId ?? null, config.corpId, localUserId, profile],
      )
      if (inserted.rows.length === 0) {
        throw createPolicyError('DingTalk identity is already bound to another local user', {
          statusCode: 409,
          code: 'identity_already_bound',
        })
      }
      accessGraphChanged = true
    }

    if (accessGraphChanged) {
      await supersedeDeprovisionEvidenceForAccessGraphWrite(client, {
        userIds: [localUserId],
        actorId: localUserId,
        reason: 'DingTalk OAuth identity binding changed',
      })
    }
  })
}

// Directory-managed users can be found by unionId before their web-OAuth openId
// is known. Enrich that missing openId without granting a rejected login.
async function enrichMissingOpenIdForRejectedLogin(localUserId: string, dtUser: DingTalkUserInfo): Promise<void> {
  if (!dtUser.openId) return

  const config = readDingTalkOauthConfig()
  const externalKey = buildExternalKey(dtUser)
  const openId = dtUser.openId
  const unionId = dtUser.unionId || ''
  const profile = JSON.stringify(dtUser)

  await transaction(async (client) => {
    const lockedUsers = await lockUsersForAccessGraphWrite(client, [localUserId])
    if (!lockedUsers.has(localUserId)) return
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

    await client.query(
      `UPDATE user_external_identities
       SET external_key = $3,
           provider_union_id = COALESCE($4, provider_union_id),
           provider_open_id = $5,
           corp_id = COALESCE($6, corp_id),
           profile = $7::jsonb,
           updated_at = NOW()
       WHERE provider = $1
         AND local_user_id = $2
         AND COALESCE(provider_open_id, '') = ''`,
      [PROVIDER, localUserId, externalKey, dtUser.unionId || null, openId, config.corpId || null, profile],
    )
  })
}

async function findUserByEmail(email: string): Promise<LocalUserRow | null> {
  const result = await query<LocalUserRow>(
    `SELECT id,
            email,
            COALESCE(name, '') AS name,
            COALESCE(role, 'user') AS role,
            COALESCE(is_active, TRUE) AS is_active,
            activation_status
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
              COALESCE(u.is_active, TRUE) AS is_active,
              u.activation_status
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
    // Fail CLOSED (post-merge review P2-2): the same collapse readGrantState fixes lived here
    // too — a swallowed read error returned null, indistinguishable from "no linked identity",
    // so a failed identity read let the login fall through to the email-link / auto-provision
    // path as if the DingTalk person were unknown (defeating the deny row their real identity
    // carries; the identity unique constraint stopped a full bypass, but it is a latent
    // fail-open and mints stray grants). "No identity" is still a legitimate null (new user);
    // only a read FAILURE now throws.
    logger.warn('Failed to resolve DingTalk external identity; failing closed', error instanceof Error ? error : undefined)
    throw createPolicyError(
      'Unable to verify DingTalk login authorization; please retry',
      { statusCode: 503, code: 'grant_state_unavailable' },
    )
  }
}

function assertLocalUserLoginAllowed(localUser: LocalUserRow): void {
  // Shared closed-set gate (PR #4559): only exact pending_activation | activated.
  const denial = evaluateUserAuthenticationGate({
    is_active: localUser.is_active,
    role: localUser.role,
    activation_status: localUser.activation_status,
  })
  if (!denial) return
  if (denial.code === 'ACCOUNT_PENDING_ACTIVATION' || denial.code === 'ACCOUNT_ACTIVATION_INVALID') {
    throw createPolicyError(denial.message, {
      statusCode: 403,
      code: denial.code,
    })
  }
  throw createPolicyError(DINGTALK_LOGIN_DISABLED_ERROR, {
    statusCode: 403,
    code: 'local_user_disabled',
  })
}

// W4-PRE-1 policy (§3.3 item 2 of the Wave-4 onboarding design lock, docs/development/
// attendance-vnext-wave4-onboarding-design-lock-20260721.md): DingTalk OAuth JIT admission has
// no per-org context anywhere in this module — `readDingTalkOauthConfig()` reads a single
// deployment-wide `DINGTALK_CORP_ID` env var, not an org-scoped value, and there is no
// existing corp_id→org resolution primitive elsewhere in this codebase this call could reuse
// (the directory-sync admission path resolves org from a `directory_integrations` ROW, which
// this login flow never touches). Inventing a new corp_id→org inference here would be new
// design surface, not a wiring fix, and risks a WRONG org being silently attached (worse than
// none). Per the explicit ticket instruction, org-unknowable paths record policy and do NOT
// guess. Deliberately: this function does NOT write user_orgs. Verified by
// tests/integration/attendance-w4pre1-user-orgs-policy.db.test.ts (zero user_orgs rows for a
// user created via this path).
async function createProvisionedUser(dtUser: DingTalkUserInfo): Promise<LocalUserRow> {
  const userId = crypto.randomUUID()
  // unionId first (review #3771 P2-1): the container surface has no openId, and
  // `dingtalk_undefined@…` collides on the users.email UNIQUE index from the
  // second emailless provisioned user onward. unionId is guaranteed non-empty.
  const email = dtUser.email || `dingtalk_${dtUser.unionId || dtUser.openId}@placeholder.local`
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

  // Real identifiers only for the login-alias namespace. The synthetic
  // `dingtalk_*@placeholder.local` email is stored on users.email for uniqueness
  // but must NEVER be claimed as a login alias (alias full-writer coverage).
  const realEmail = dtUser.email && !isDingTalkPlaceholderEmail(dtUser.email) ? dtUser.email : null
  const realMobile = dtUser.mobile && String(dtUser.mobile).trim() ? dtUser.mobile : null

  try {
    // Load-bearing alias writer hook: claim real email/mobile inside the same transaction
    // as the JIT users insert. Removing claimNonEmptyLoginAliasesOrThrow must fail the
    // dingtalk_jit writer tests. Placeholder email is intentionally omitted from claims.
    const row = await transaction(async (client) => {
      // Persist real mobile on users.mobile in the same transaction as the alias claim.
      // Claiming a mobile login alias without storing users.mobile left profile/login
      // mirrors inconsistent under T2a OR-column reads.
      const result = await client.query(
        `INSERT INTO users (
           id, email, name, mobile, password_hash, role,
           activation_status, local_password_set, is_active,
           created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, 'user', 'activated', FALSE, TRUE, NOW(), NOW())
         RETURNING id,
                   email,
                   COALESCE(name, '') AS name,
                   COALESCE(role, 'user') AS role,
                   COALESCE(is_active, TRUE) AS is_active,
                   activation_status`,
        [userId, email, name, realMobile, passwordHash],
      )

      const created = result.rows[0] as LocalUserRow | undefined
      if (!created) {
        throw new Error('Failed to create local user for DingTalk login')
      }

      if (realEmail || realMobile) {
        await claimNonEmptyLoginAliasesOrThrow({
          userId,
          email: realEmail,
          mobile: realMobile,
          source: 'dingtalk_jit',
          client,
        })
      }

      return created
    })
    return row
  } catch (error) {
    if (error instanceof LoginAliasClaimError && error.code === 'ALIAS_CONFLICT') {
      throw createPolicyError(
        'Refusing to auto-provision DingTalk user because a login identifier is already claimed',
        {
          statusCode: 409,
          code: 'auto_provision_alias_conflict',
        },
      )
    }
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
    const grantState = await readGrantState(identityUser.id)
    if (requireGrant && grantState !== 'enabled') {
      await enrichMissingOpenIdForRejectedLogin(identityUser.id, dtUser)
      throw createPolicyError('DingTalk login is not enabled for this user', {
        statusCode: 403,
        code: 'grant_required',
      })
    }
    if (grantState === 'disabled') {
      await enrichMissingOpenIdForRejectedLogin(identityUser.id, dtUser)
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
      const grantState = await readGrantState(emailUser.id)
      if (requireGrant && grantState !== 'enabled') {
        throw createPolicyError('DingTalk login is not enabled for this user', {
          statusCode: 403,
          code: 'grant_required',
        })
      }
      if (grantState === 'disabled') {
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
    throw createPolicyError(
      dtUser.email
        ? `DingTalk account ${dtUser.email} is not linked to an enabled local user`
        : 'DingTalk account is not linked to an enabled local user',
      {
        statusCode: 403,
        code: 'unlinked_enabled_local_user',
      },
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

  // DT-HARDEN-09: auto-provision + an empty DINGTALK_ALLOWED_CORP_IDS is an
  // unscoped "any DingTalk corp can self-register a local account" hole —
  // isDingTalkCorpAllowed/assertDingTalkCorpAllowed are permissive when the
  // allowlist is empty, so without this fence any corp's OAuth user would be
  // silently auto-provisioned. Require an explicit non-empty allowlist before
  // auto-provision is allowed to create anything; fall back to the same
  // unlinked/403 path used when auto-provision is disabled outright.
  if (!isCorpAllowlistConfigured()) {
    logger.warn(
      'DingTalk auto-provision blocked: DINGTALK_AUTH_AUTO_PROVISION is enabled but ' +
      'DINGTALK_ALLOWED_CORP_IDS is empty (unscoped allowlist) — refusing to auto-create ' +
      'a local user; configure DINGTALK_ALLOWED_CORP_IDS to enable auto-provision',
      { email: dtUser.email || null, unionId: dtUser.unionId || null },
    )
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
  activateUserId?: string | null
  activateAdminUserId?: string | null
} = {}): Promise<string> {
  const state = crypto.randomUUID()
  const normalizedIntent = options.intent === 'bind' || options.intent === 'activate'
    ? options.intent
    : null
  const normalizedBindUserId = typeof options.bindUserId === 'string' && options.bindUserId.trim().length > 0
    ? options.bindUserId.trim()
    : null
  const normalizedActivateUserId = typeof options.activateUserId === 'string' && options.activateUserId.trim().length > 0
    ? options.activateUserId.trim()
    : null
  const normalizedActivateAdminUserId = typeof options.activateAdminUserId === 'string' && options.activateAdminUserId.trim().length > 0
    ? options.activateAdminUserId.trim()
    : null
  if (normalizedIntent === 'bind' && !normalizedBindUserId) {
    throw new Error('DingTalk bind state requires a user')
  }
  if (
    normalizedIntent === 'activate'
    && (!normalizedActivateUserId || !normalizedActivateAdminUserId)
  ) {
    throw new Error('DingTalk activation state requires target and administrator')
  }
  const record: StateRecord = {
    expiresAt: Date.now() + STATE_TTL_MS,
    ...(typeof options.redirectPath === 'string' && options.redirectPath.trim().length > 0
      ? { redirectPath: options.redirectPath.trim() }
      : {}),
    ...(normalizedIntent ? { intent: normalizedIntent } : {}),
    ...(normalizedIntent === 'bind' && normalizedBindUserId ? { bindUserId: normalizedBindUserId } : {}),
    ...(normalizedIntent === 'activate' && normalizedActivateUserId
      ? { activateUserId: normalizedActivateUserId }
      : {}),
    ...(normalizedIntent === 'activate' && normalizedActivateAdminUserId
      ? { activateAdminUserId: normalizedActivateAdminUserId }
      : {}),
  }

  const storedInRedis = await writeStateToRedis(state, record)
  if (!storedInRedis) {
    // DT-OPS-05: the in-process Map is only a single-replica convenience. Behind more
    // than one replica the callback can land on a different instance than the launch, so
    // a valid state is rejected and the login fails; one-time-use is also only guaranteed
    // per process. Deployments that require a shared store fail closed instead of
    // silently degrading to memory.
    if (isDingTalkOAuthSharedStateStoreRequired()) {
      recordDingTalkOAuthStateOperation('write', 'error')
      throw new DingTalkOAuthStateStoreUnavailableError()
    }
    writeStateToMemory(state, record)
    recordDingTalkOAuthStateFallback('write')
    recordDingTalkOAuthStateOperation('write', 'ok')
  } else {
    recordDingTalkOAuthStateOperation('write', 'ok')
  }

  return state
}

export async function validateState(state: string): Promise<StateValidationResult> {
  if (!state) return { valid: false, error: 'Missing required parameter: state' }

  const redisResult = await validateStateFromRedis(state)
  // `null` means the shared store was unavailable (no client / a failed exec / a thrown
  // error) — a real Redis answer (valid, invalid/miss, or expired) is always non-null. This
  // distinction drives both the ok/error split and whether falling through to memory counts
  // as fallback degradation below.
  const redisStoreUnavailable = redisResult === null

  // DT-OPS-05: when a shared store is required, NEVER consult the per-process Map — a
  // transient Redis outage must fail the login rather than quietly fall through to a
  // store the other replicas cannot see. `null` here means the store was unavailable
  // (a real miss returns an explicit invalid result).
  if (isDingTalkOAuthSharedStateStoreRequired()) {
    if (redisResult) {
      recordDingTalkOAuthStateOperation('validate', 'ok')
      return redisResult
    }
    recordDingTalkOAuthStateOperation('validate', 'error')
    logger.error('DingTalk OAuth state store is unavailable and a shared store is required; refusing the login')
    return { valid: false, error: 'DingTalk login is temporarily unavailable. Please try again.' }
  }

  if (redisResult?.valid) {
    recordDingTalkOAuthStateOperation('validate', 'ok')
    return redisResult
  }
  if (redisResult?.error === 'State parameter has expired') {
    recordDingTalkOAuthStateOperation('validate', 'ok')
    return redisResult
  }

  // Either Redis was unavailable (redisStoreUnavailable) or it gave a clean miss that still
  // falls through to the defensive memory check (normal single-replica flow). Only the
  // unavailable case is a fallback signal — a clean miss falling through here is expected
  // behavior, not degradation.
  if (redisStoreUnavailable) {
    recordDingTalkOAuthStateFallback('validate')
  }
  const memoryResult = validateStateFromMemory(state)
  recordDingTalkOAuthStateOperation('validate', 'ok')
  return memoryResult
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

/**
 * E1 container login (e1-container-login design-lock §1): exchange an
 * in-container enterprise 免登 authCode for a local user. Same private
 * resolveLocalUser — require-grant / corp allowlist / auto-link /
 * auto-provision / disabled-user gates apply with identical semantics.
 */
export async function exchangeEnterpriseAuthCodeForUser(authCode: string): Promise<DingTalkExchangeResult> {
  // Same config/corp gate as web-OAuth (assertDingTalkCorpAllowed fires inside);
  // the client-id/secret aliases double as appKey/appSecret for the app token.
  // E1 therefore shares web-OAuth's env prerequisites — the embed direction
  // lock's premise is that web SSO is already configured.
  const oauthConfig = readDingTalkOauthConfig()
  const appConfig = {
    appKey: oauthConfig.clientId,
    appSecret: oauthConfig.clientSecret,
    baseUrl: process.env.DINGTALK_BASE_URL || undefined,
  }
  const accessToken = await fetchDingTalkAppAccessToken(appConfig)
  const info = await getDingTalkUserInfoByAuthCode(accessToken, authCode, appConfig)

  // The container chain's only cross-surface-stable identity key is unionId
  // (lock §2). getuserinfo may omit it; topapi/v2/user/get reliably has it.
  let unionId = info.unionId
  let detailName = ''
  let detailEmail: string | undefined
  let detailMobile: string | undefined
  let detailAvatar: string | undefined
  try {
    const detail = await getDingTalkUserDetail(accessToken, info.userId, appConfig)
    unionId = unionId || detail.unionId
    detailName = detail.name
    detailEmail = detail.email
    detailMobile = detail.mobile
    detailAvatar = detail.avatarUrl
  } catch (error) {
    if (!unionId) throw error
    logger.warn('DingTalk container login: user detail lookup failed; proceeding with getuserinfo fields', error)
  }
  if (!unionId) {
    throw new DingTalkLoginPolicyError(
      'DingTalk container login could not resolve a stable identity key (unionId)',
      { statusCode: 502, code: 'identity_key_unavailable' },
    )
  }

  const dingtalkUser: DingTalkUserInfo = {
    unionId,
    nick: detailName || `dingtalk-${info.userId}`,
    email: detailEmail,
    mobile: detailMobile,
    avatarUrl: detailAvatar,
  }
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

// Binds a DingTalk identity to a local user. Rebind semantics: if the user
// already owns a DingTalk identity row it is updated to the incoming profile
// (self-replacement is allowed by design — the user is opting in via callback).
// A different user owning this identity always returns 409; cross-user
// takeover must go through the admin directory flow, not self-service.
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
    const lockedUsers = await lockUsersForAccessGraphWrite(client, [localUserId])
    if (!lockedUsers.has(localUserId)) {
      throw createPolicyError('Local user no longer exists', {
        statusCode: 403,
        code: 'local_user_disabled',
      })
    }
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
      `SELECT id,
              external_key,
              provider_union_id,
              provider_open_id,
              corp_id
       FROM user_external_identities
       WHERE provider = $1 AND local_user_id = $2
       FOR UPDATE
       LIMIT 1`,
      [PROVIDER, localUserId],
    )

    let accessGraphChanged = false
    if (existingByUser.rows.length > 0) {
      const existing = existingByUser.rows[0]
      accessGraphChanged =
        existing.external_key !== externalKey
        || (existing.provider_union_id ?? null) !== (dtUser.unionId || null)
        || (existing.provider_open_id ?? null) !== (dtUser.openId || null)
        || (existing.corp_id ?? null) !== (config.corpId || null)
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
      const inserted = await client.query(
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
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW())
         ON CONFLICT (provider, external_key) DO NOTHING
         RETURNING id`,
        [PROVIDER, externalKey, dtUser.unionId || null, dtUser.openId, config.corpId, localUserId, profile, boundBy],
      )
      if (inserted.rows.length === 0) {
        throw createPolicyError('DingTalk identity is already bound to another local user', {
          statusCode: 409,
          code: 'identity_already_bound',
        })
      }
      accessGraphChanged = true
    }

    if (enableGrant) {
      const grant = await client.query(
        `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by, created_at, updated_at)
         VALUES ($1, $2, TRUE, $3, NOW(), NOW())
         ON CONFLICT (provider, local_user_id)
         DO UPDATE SET
           enabled = TRUE,
           granted_by = EXCLUDED.granted_by,
           updated_at = NOW()
         WHERE user_external_auth_grants.enabled IS DISTINCT FROM TRUE
         RETURNING local_user_id`,
        [PROVIDER, localUserId, boundBy],
      )
      accessGraphChanged ||= grant.rows.length > 0
    }
    if (accessGraphChanged) {
      await supersedeDeprovisionEvidenceForAccessGraphWrite(client, {
        userIds: [localUserId],
        actorId: boundBy,
        reason: 'DingTalk identity bound by OAuth callback',
      })
    }
  })
}

export async function unbindSelfManagedDingTalkIdentity(input: {
  localUserId: string
  actorId?: string
}): Promise<boolean> {
  const localUserId = String(input.localUserId || '').trim()
  const actorId = String(input.actorId || '').trim() || localUserId
  if (!localUserId) throw new Error('localUserId is required')

  return transaction(async (client) => {
    const lockedUsers = await lockUsersForAccessGraphWrite(client, [localUserId])
    if (!lockedUsers.has(localUserId)) {
      throw createPolicyError('Local user no longer exists', {
        statusCode: 403,
        code: 'local_user_disabled',
      })
    }
    const managedLink = await client.query(
      `SELECT 1
         FROM directory_account_links link
         JOIN directory_accounts account
           ON account.id = link.directory_account_id
        WHERE link.local_user_id = $1::text
          AND link.link_status = 'linked'
          AND account.provider = $2::text
        LIMIT 1`,
      [localUserId, PROVIDER],
    )
    if (managedLink.rows.length > 0) {
      throw createPolicyError(
        'Current DingTalk identity is directory-managed. Please contact an administrator.',
        {
          statusCode: 409,
          code: 'directory_managed_identity',
        },
      )
    }

    const removed = await client.query(
      `DELETE FROM user_external_identities
        WHERE provider = $1 AND local_user_id = $2
        RETURNING id`,
      [PROVIDER, localUserId],
    )
    if (removed.rows.length === 0) return false

    await supersedeDeprovisionEvidenceForAccessGraphWrite(client, {
      userIds: [localUserId],
      actorId,
      reason: 'DingTalk identity unbound by the local user',
    })
    return true
  })
}

/**
 * W4-PRE-1 (§3.3 item 2): test-only seam so the "org-unknowable path does not silently write
 * user_orgs" policy (see the comment on createProvisionedUser above) can be verified against a
 * real admission, not just read as a comment. Mirrors the __directorySyncInternalsForTests
 * pattern in directory-sync.ts — not a new production surface.
 */
export const __dingtalkOAuthInternalsForTests = {
  createProvisionedUser,
  ensureGrant,
}
