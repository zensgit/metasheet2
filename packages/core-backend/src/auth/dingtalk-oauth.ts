/**
 * DingTalk OAuth service
 *
 * Provides the minimum surface for DingTalk login:
 *   1. buildAuthUrl() – constructs the DingTalk authorize URL for the frontend redirect
 *   2. exchangeCodeForUser() – exchanges an auth code for a DingTalk user identity,
 *      then resolves or creates the local user record
 *
 * Required env:
 *   DINGTALK_CLIENT_ID     – DingTalk app key
 *   DINGTALK_CLIENT_SECRET – DingTalk app secret
 *   DINGTALK_REDIRECT_URI  – must match the registered callback URL
 *
 * If any required env is missing, the functions throw a descriptive error.
 */

import { query } from '../db/pg'
import { Logger } from '../core/logger'
import { metrics } from '../metrics/metrics'
import Redis from 'ioredis'

const logger = new Logger('DingTalkOAuth')

export interface DingTalkConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export interface DingTalkUserInfo {
  openId: string
  unionId: string
  nick: string
  email?: string
}

export interface DingTalkExchangeResult {
  dingtalkUser: DingTalkUserInfo
  localUserId: string
  localUserEmail: string
  localUserName: string
  localUserRole: string
  isNewUser: boolean
}

function readConfig(): DingTalkConfig {
  const clientId = process.env.DINGTALK_CLIENT_ID?.trim() ?? ''
  const clientSecret = process.env.DINGTALK_CLIENT_SECRET?.trim() ?? ''
  const redirectUri = process.env.DINGTALK_REDIRECT_URI?.trim() ?? ''

  if (!clientId) throw new Error('DINGTALK_CLIENT_ID is not configured')
  if (!clientSecret) throw new Error('DINGTALK_CLIENT_SECRET is not configured')
  if (!redirectUri) throw new Error('DINGTALK_REDIRECT_URI is not configured')

  return { clientId, clientSecret, redirectUri }
}

export function isDingTalkConfigured(): boolean {
  return Boolean(
    process.env.DINGTALK_CLIENT_ID?.trim() &&
    process.env.DINGTALK_CLIENT_SECRET?.trim() &&
    process.env.DINGTALK_REDIRECT_URI?.trim(),
  )
}

// ============================================
// OAuth state store (Redis-first with in-memory fallback)
// ============================================

const STATE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const MAX_PENDING_STATES = 10_000
const STATE_REDIS_RETENTION_MS = 60 * 1000
const STATE_REDIS_KEY_PREFIX = 'metasheet:auth:dingtalk:state:'
const STATE_REDIS_INDEX_KEY = 'metasheet:auth:dingtalk:state:index'

const pendingStates = new Map<string, number>() // state → expiresAt
let redisStateClient: Redis | null = null
let redisStateClientPromise: Promise<Redis | null> | null = null
let redisFallbackLogged = false

interface StateRecord {
  expiresAt: number
}

interface StateValidationResult {
  valid: boolean
  error?: string
}

function observeRedisStateOperation(op: string, startedAtMs: number): void {
  try {
    metrics.redisOperationDuration.labels(op).observe((Date.now() - startedAtMs) / 1000)
  } catch {
    // Metrics are non-critical.
  }
}

function recordStateOp(
  operation: 'generate' | 'validate',
  store: 'redis' | 'memory' | 'none',
  result: 'success' | 'fallback' | 'missing' | 'invalid' | 'expired' | 'error',
): void {
  try {
    metrics.dingtalkOauthStateOpsTotal.labels(operation, store, result).inc()
  } catch {
    // Metrics are non-critical.
  }
}

function recordStateFallback(
  operation: 'generate' | 'validate',
  reason: 'redis_unavailable' | 'redis_write_failed' | 'redis_validation_failed',
): void {
  try {
    metrics.dingtalkOauthStateFallbackTotal.labels(operation, reason).inc()
  } catch {
    // Metrics are non-critical.
  }
}

function pruneExpiredStates(): void {
  const now = Date.now()
  for (const [key, expiresAt] of pendingStates) {
    if (expiresAt <= now) pendingStates.delete(key)
  }
}

function logRedisFallback(reason: string, error?: unknown): void {
  if (redisFallbackLogged) return
  redisFallbackLogged = true
  logger.warn(
    `Falling back to in-memory DingTalk OAuth state store: ${reason}${error instanceof Error ? ` (${error.message})` : ''}`,
    {
      mode: 'memory-fallback',
      reason,
    },
  )
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
      if (redisFallbackLogged) {
        logger.info('Recovered DingTalk OAuth state store to Redis', {
          mode: 'redis',
        })
      }
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
  if (expiredStateIds.length > 0) {
    const keys = expiredStateIds.map((state) => stateRedisKey(state))
    const cleanup = client.multi()
    cleanup.del(...keys)
    cleanup.zrem(STATE_REDIS_INDEX_KEY, ...expiredStateIds)
    await cleanup.exec()
  }
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

async function writeStateToRedis(state: string, expiresAt: number): Promise<boolean> {
  const startedAtMs = Date.now()
  const client = await getRedisStateClient()
  if (!client) {
    if (buildRedisUrl()) {
      recordStateFallback('generate', 'redis_unavailable')
    }
    recordStateOp('generate', 'redis', 'fallback')
    return false
  }

  try {
    await pruneRedisStateIndex(client, Date.now())
    await trimRedisStateIndex(client)

    const ttlMs = Math.max(expiresAt - Date.now() + STATE_REDIS_RETENTION_MS, STATE_REDIS_RETENTION_MS)
    await client.multi()
      .set(stateRedisKey(state), JSON.stringify({ expiresAt } satisfies StateRecord), 'PX', ttlMs)
      .zadd(STATE_REDIS_INDEX_KEY, expiresAt, state)
      .exec()
    recordStateOp('generate', 'redis', 'success')
    observeRedisStateOperation('dingtalk_oauth_state_write', startedAtMs)
    return true
  } catch (error) {
    recordStateFallback('generate', 'redis_write_failed')
    recordStateOp('generate', 'redis', 'error')
    logRedisFallback('Redis state write failed', error)
    await invalidateRedisStateClient(client)
    observeRedisStateOperation('dingtalk_oauth_state_write', startedAtMs)
    return false
  }
}

async function validateStateFromRedis(state: string): Promise<StateValidationResult | null> {
  const startedAtMs = Date.now()
  const client = await getRedisStateClient()
  if (!client) {
    if (buildRedisUrl()) {
      recordStateFallback('validate', 'redis_unavailable')
    }
    recordStateOp('validate', 'redis', 'fallback')
    return null
  }

  try {
    const results = await client.multi()
      .get(stateRedisKey(state))
      .del(stateRedisKey(state))
      .zrem(STATE_REDIS_INDEX_KEY, state)
      .exec()

    const statePayload = results?.[0]?.[1]
    if (typeof statePayload !== 'string') {
      recordStateOp('validate', 'redis', 'invalid')
      observeRedisStateOperation('dingtalk_oauth_state_validate', startedAtMs)
      return { valid: false, error: 'Invalid or unknown state parameter' }
    }

    let parsed: StateRecord | null = null
    try {
      parsed = JSON.parse(statePayload) as StateRecord
    } catch {
      parsed = null
    }

    if (!parsed || typeof parsed.expiresAt !== 'number') {
      recordStateOp('validate', 'redis', 'invalid')
      observeRedisStateOperation('dingtalk_oauth_state_validate', startedAtMs)
      return { valid: false, error: 'Invalid or unknown state parameter' }
    }

    if (Date.now() > parsed.expiresAt) {
      recordStateOp('validate', 'redis', 'expired')
      observeRedisStateOperation('dingtalk_oauth_state_validate', startedAtMs)
      return { valid: false, error: 'State parameter has expired' }
    }

    recordStateOp('validate', 'redis', 'success')
    observeRedisStateOperation('dingtalk_oauth_state_validate', startedAtMs)
    return { valid: true }
  } catch (error) {
    recordStateFallback('validate', 'redis_validation_failed')
    recordStateOp('validate', 'redis', 'error')
    logRedisFallback('Redis state validation failed', error)
    await invalidateRedisStateClient(client)
    observeRedisStateOperation('dingtalk_oauth_state_validate', startedAtMs)
    return null
  }
}

function writeStateToMemory(state: string, expiresAt: number): void {
  pruneExpiredStates()
  if (pendingStates.size >= MAX_PENDING_STATES) {
    const oldest = pendingStates.keys().next().value
    if (oldest) pendingStates.delete(oldest)
  }
  pendingStates.set(state, expiresAt)
  recordStateOp('generate', 'memory', 'success')
}

function validateStateFromMemory(state: string): StateValidationResult {
  if (!state) {
    recordStateOp('validate', 'none', 'missing')
    return { valid: false, error: 'Missing required parameter: state' }
  }
  const expiresAt = pendingStates.get(state)
  if (expiresAt === undefined) {
    recordStateOp('validate', 'memory', 'invalid')
    return { valid: false, error: 'Invalid or unknown state parameter' }
  }
  pendingStates.delete(state) // consume: one-time use
  if (Date.now() > expiresAt) {
    recordStateOp('validate', 'memory', 'expired')
    return { valid: false, error: 'State parameter has expired' }
  }
  recordStateOp('validate', 'memory', 'success')
  return { valid: true }
}

export async function generateState(): Promise<string> {
  const state = crypto.randomUUID()
  const expiresAt = Date.now() + STATE_TTL_MS

  const storedInRedis = await writeStateToRedis(state, expiresAt)
  if (!storedInRedis) {
    writeStateToMemory(state, expiresAt)
  }

  return state
}

export async function validateState(state: string): Promise<StateValidationResult> {
  if (!state) return validateStateFromMemory(state)

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

/**
 * Build the DingTalk authorization URL that the frontend should redirect to.
 */
export function buildAuthUrl(state: string): string {
  const cfg = readConfig()
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'openid',
    state,
    prompt: 'consent',
  })
  return `https://login.dingtalk.com/oauth2/auth?${params.toString()}`
}

/**
 * Exchange a DingTalk auth code for a local user.
 *
 * Steps:
 *   1. POST to DingTalk token endpoint to get an access token
 *   2. GET DingTalk user info with that access token
 *   3. Upsert local user linked to the DingTalk identity
 */
export async function exchangeCodeForUser(code: string): Promise<DingTalkExchangeResult> {
  const cfg = readConfig()

  // Step 1: Exchange code for access token
  const tokenRes = await fetch('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      code,
      grantType: 'authorization_code',
    }),
  })

  const tokenBody = await tokenRes.json() as Record<string, unknown>
  const accessToken = typeof tokenBody.accessToken === 'string' ? tokenBody.accessToken : ''

  if (!accessToken) {
    const errMsg = typeof tokenBody.message === 'string' ? tokenBody.message : 'Failed to obtain access token from DingTalk'
    logger.warn(`DingTalk token exchange failed: ${errMsg}`)
    throw new Error(errMsg)
  }

  // Step 2: Get user info
  const userRes = await fetch('https://api.dingtalk.com/v1.0/contact/users/me', {
    method: 'GET',
    headers: { 'x-acs-dingtalk-access-token': accessToken },
  })

  const userBody = await userRes.json() as Record<string, unknown>
  const openId = typeof userBody.openId === 'string' ? userBody.openId : ''
  const unionId = typeof userBody.unionId === 'string' ? userBody.unionId : ''
  const nick = typeof userBody.nick === 'string' ? userBody.nick : ''
  const email = typeof userBody.email === 'string' ? userBody.email : undefined

  if (!openId) {
    const errMsg = typeof userBody.message === 'string' ? userBody.message : 'Failed to get user info from DingTalk'
    logger.warn(`DingTalk user info failed: ${errMsg}`)
    throw new Error(errMsg)
  }

  const dingtalkUser: DingTalkUserInfo = { openId, unionId, nick, email }

  // Step 3: Resolve or create local user
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

interface LocalUserRow {
  id: string
  email: string
  name: string
  role: string
}

async function resolveLocalUser(
  dtUser: DingTalkUserInfo,
): Promise<{ localUser: LocalUserRow; isNewUser: boolean }> {
  // Try to find by dingtalk_open_id
  try {
    const existing = await query(
      `SELECT id, email, COALESCE(name, '') AS name, COALESCE(role, 'user') AS role
       FROM users WHERE dingtalk_open_id = $1 LIMIT 1`,
      [dtUser.openId],
    )
    if (existing.rows.length > 0) {
      return { localUser: existing.rows[0] as LocalUserRow, isNewUser: false }
    }
  } catch {
    // Column may not exist yet — fall through to email lookup
  }

  // Fall back: try to match by email
  if (dtUser.email) {
    const byEmail = await query(
      `SELECT id, email, COALESCE(name, '') AS name, COALESCE(role, 'user') AS role
       FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [dtUser.email],
    )
    if (byEmail.rows.length > 0) {
      // Link the DingTalk identity
      try {
        await query(`UPDATE users SET dingtalk_open_id = $1 WHERE id = $2`, [dtUser.openId, (byEmail.rows[0] as LocalUserRow).id])
      } catch {
        // Column may not exist; not fatal
      }
      return { localUser: byEmail.rows[0] as LocalUserRow, isNewUser: false }
    }
  }

  // Create a new user
  const userId = crypto.randomUUID()
  const userEmail = dtUser.email || `dingtalk_${dtUser.openId}@placeholder.local`
  const userName = dtUser.nick || 'DingTalk User'

  await query(
    `INSERT INTO users (id, email, name, role, created_at, updated_at)
     VALUES ($1, $2, $3, 'user', NOW(), NOW())
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
     RETURNING id, email, name, role`,
    [userId, userEmail, userName],
  )

  // Try to link DingTalk identity
  try {
    await query(`UPDATE users SET dingtalk_open_id = $1 WHERE id = $2`, [dtUser.openId, userId])
  } catch {
    // Column may not exist; not fatal
  }

  return {
    localUser: { id: userId, email: userEmail, name: userName, role: 'user' },
    isNewUser: true,
  }
}
