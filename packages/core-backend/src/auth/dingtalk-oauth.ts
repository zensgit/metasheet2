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
// OAuth state store (in-memory with TTL)
// ============================================

const STATE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const MAX_PENDING_STATES = 10_000

const pendingStates = new Map<string, number>() // state → expiresAt

function pruneExpiredStates(): void {
  const now = Date.now()
  for (const [key, expiresAt] of pendingStates) {
    if (expiresAt <= now) pendingStates.delete(key)
  }
}

export function generateState(): string {
  pruneExpiredStates()
  if (pendingStates.size >= MAX_PENDING_STATES) {
    const oldest = pendingStates.keys().next().value
    if (oldest) pendingStates.delete(oldest)
  }
  const state = crypto.randomUUID()
  pendingStates.set(state, Date.now() + STATE_TTL_MS)
  return state
}

export function validateState(state: string): { valid: boolean; error?: string } {
  if (!state) return { valid: false, error: 'Missing required parameter: state' }
  const expiresAt = pendingStates.get(state)
  if (expiresAt === undefined) return { valid: false, error: 'Invalid or unknown state parameter' }
  pendingStates.delete(state) // consume: one-time use
  if (Date.now() > expiresAt) return { valid: false, error: 'State parameter has expired' }
  return { valid: true }
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
