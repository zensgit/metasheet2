/**
 * 认证路由
 * 提供登录、注册、token刷新等认证服务
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express'
import { hash } from 'bcryptjs'
import { randomUUID } from 'crypto'
import jwt, { type SignOptions } from 'jsonwebtoken'
import { authService, type User } from '../auth/AuthService'
import { buildOnboardingPacket, getAccessPreset } from '../auth/access-presets'
import { dingTalkAuthService, isDingTalkAuthExchangeError, type DingTalkIdentityProfile, type DingTalkAuthState } from '../auth/dingtalk-auth'
import {
  buildDingTalkExternalKey,
  deleteUserExternalIdentity,
  findDingTalkExternalIdentity,
  listUserExternalIdentities,
  type UserExternalIdentity,
  upsertExternalIdentity,
  touchExternalIdentityLogin,
} from '../auth/external-identities'
import { isUserExternalAuthEnabled } from '../auth/external-auth-grants'
import { verifyInviteToken } from '../auth/invite-tokens'
import { createUserSession, getUserSession, listUserSessions, refreshUserSessionExpiry, revokeOtherUserSessions, revokeUserSession, touchUserSession } from '../auth/session-registry'
import { revokeUserSessions } from '../auth/session-revocation'
import { auditLog } from '../audit/audit'
import { query, transaction } from '../db/pg'
import { FEATURE_FLAGS } from '../config/flags'
import { Logger } from '../core/logger'
import { directorySyncService } from '../directory/directory-sync'

const logger = new Logger('AuthRouter')

export const authRouter = Router()

type ProductMode = 'platform' | 'attendance'

type ProductFeatures = {
  attendance: boolean
  workflow: boolean
  platformAdmin: boolean
  attendanceAdmin: boolean
  attendanceImport: boolean
  mode: ProductMode
}

type SessionTokenPayload = {
  sub?: unknown
  sid?: unknown
  id?: unknown
}

type InviteUserRecord = {
  id: string
  email: string
  name: string
  is_active: boolean | null
  updated_at: string | Date
}

type InviteLedgerRecord = {
  id: string
  user_id: string
  email: string
  preset_id: string | null
  product_mode: string | null
  role_id: string | null
  invited_by: string | null
  invite_token: string
  status: string
  accepted_at: string | Date | null
  consumed_by: string | null
  last_sent_at: string | Date | null
  created_at: string | Date
  updated_at: string | Date
}

type LocalUserRecord = {
  id: string
  email: string
  name: string | null
  role: string
  permissions: string[]
  created_at: string | Date
  updated_at: string | Date
}

type DingTalkExchangeResult = {
  user: User
  binding: UserExternalIdentity
  token?: string
  redirect: string
  features: ProductFeatures
  provisioned: boolean
  onboarding?: ReturnType<typeof buildOnboardingPacket>
}

class AuthRouteError extends Error {
  status: number
  code: string
  details?: Record<string, unknown>

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

function normalizeProductMode(value: unknown): ProductMode {
  return value === 'attendance' || value === 'attendance-focused' ? 'attendance' : 'platform'
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toPermissionsList(user: User): string[] {
  return Array.isArray(user.permissions) ? user.permissions : []
}

function deriveProductFeatures(user: User): ProductFeatures {
  const permissions = toPermissionsList(user)
  const isAdmin = user.role === 'admin'

  return {
    attendance: isAdmin || permissions.some((permission) => permission.startsWith('attendance:')),
    workflow: FEATURE_FLAGS.workflowEnabled,
    platformAdmin: isAdmin,
    attendanceAdmin: isAdmin || permissions.includes('attendance:admin'),
    attendanceImport: isAdmin || permissions.includes('attendance:write'),
    mode: normalizeProductMode(process.env.PRODUCT_MODE),
  }
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization
  return authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null
}

function extractUserIdFromPayload(
  payload: SessionTokenPayload | null,
  user: User,
): string {
  const fallback = [payload?.sub, payload?.id, user.id, user.email]
  for (const candidate of fallback) {
    const trimmed = toText(candidate)
    if (trimmed.length > 0) return trimmed
  }
  return user.id
}

function mapInviteUserPayload(user: InviteUserRecord): { id: string; email: string; name: string; isActive: boolean } {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isActive: user.is_active === true,
  }
}

function sanitizeRedirectPath(value: unknown): string {
  if (typeof value !== 'string') return '/attendance'
  const trimmed = value.trim()
  if (!trimmed.startsWith('/')) return '/attendance'
  if (trimmed.startsWith('//')) return '/attendance'
  return trimmed
}

function getClientUserAgent(req: Request): string | null {
  return typeof req.headers['user-agent'] === 'string' && req.headers['user-agent'].trim().length > 0
    ? req.headers['user-agent']
    : null
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

async function issueAuthenticatedSession(
  user: User,
  req: Request,
  options: {
    authProvider?: string
  } = {},
): Promise<{ token: string; sessionId: string }> {
  const sessionId = randomUUID()
  const token = authService.createToken(user, {
    sessionId,
    authProvider: options.authProvider,
  })
  const payload = authService.readTokenPayload(token)
  const exp = typeof payload.exp === 'number' ? payload.exp : Math.floor(Date.now() / 1000) + 86400

  await createUserSession(user.id, {
    sessionId,
    expiresAt: new Date(exp * 1000).toISOString(),
    ipAddress: getClientIP(req),
    userAgent: getClientUserAgent(req),
  })

  return { token, sessionId }
}

async function getAuthenticatedUserFromRequest(req: Request): Promise<User | null> {
  const token = extractBearerToken(req)
  if (!token) return null
  return authService.verifyToken(token)
}

async function loadCanonicalUser(userId: string): Promise<User | null> {
  const result = await query<LocalUserRecord>(
    `SELECT id, email, name, role, permissions, created_at, updated_at
     FROM users
     WHERE id = $1`,
    [userId],
  )
  const row = result.rows[0]
  if (!row) return null

  const candidate: User = {
    id: row.id,
    email: row.email,
    name: row.name || '',
    role: row.role,
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  }

  return authService.verifyToken(authService.createToken(candidate))
}

function normalizeDingTalkDisplayName(profile: DingTalkIdentityProfile): string {
  const candidates = [profile.name, profile.nick, profile.email, profile.userId, profile.unionId]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return sanitizeName(candidate)
    }
  }
  return 'DingTalk User'
}

function resolveDingTalkProvisioningEmail(profile: DingTalkIdentityProfile, domain: string): string {
  const direct = [profile.email]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  if (direct) return sanitizeEmail(direct)

  const base = String(profile.userId || profile.unionId || profile.openId || randomUUID())
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
  const localPart = base.length > 0 ? base : `dingtalk-${randomUUID().slice(0, 8)}`
  return sanitizeEmail(`${localPart}@${domain}`)
}

async function autoProvisionDingTalkUser(profile: DingTalkIdentityProfile): Promise<{
  user: User
  binding: UserExternalIdentity
  onboarding: ReturnType<typeof buildOnboardingPacket>
}> {
  const provisioning = dingTalkAuthService.getProvisioningConfig()
  if (!provisioning.autoProvisionEnabled) {
    const captured = await directorySyncService.captureUnboundLoginForReview(profile)
    if (captured) {
      throw new AuthRouteError(
        409,
        'DINGTALK_ACCOUNT_REVIEW_REQUIRED',
        'DingTalk account is pending administrator provisioning',
        {
          integrationId: captured.integrationId,
          accountId: captured.accountId,
          queuedForReview: true,
          created: captured.created,
          linkStatus: captured.linkStatus,
          corpId: profile.corpId,
        },
      )
    }

    throw new AuthRouteError(409, 'DINGTALK_ACCOUNT_UNBOUND', 'DingTalk account is not bound to a MetaSheet user', {
      queuedForReview: false,
      corpId: profile.corpId,
    })
  }

  const corpId = typeof profile.corpId === 'string' ? profile.corpId.trim() : ''
  if (provisioning.allowedCorpIds.length > 0 && (!corpId || !provisioning.allowedCorpIds.includes(corpId))) {
    throw new AuthRouteError(403, 'DINGTALK_CORP_FORBIDDEN', 'This DingTalk enterprise is not allowed to auto-provision accounts', {
      corpId: corpId || null,
    })
  }

  const externalKey = buildDingTalkExternalKey(profile)
  if (!externalKey) {
    throw new AuthRouteError(422, 'DINGTALK_IDENTITY_INCOMPLETE', 'DingTalk profile did not contain a stable identity key')
  }

  const preset = getAccessPreset(provisioning.autoProvisionPresetId)
  const email = resolveDingTalkProvisioningEmail(profile, provisioning.autoProvisionEmailDomain)
  const name = normalizeDingTalkDisplayName(profile)

  const existingUser = await query<{ id: string }>('SELECT id FROM users WHERE email = $1 LIMIT 1', [email])
  if (existingUser.rows.length > 0) {
    throw new AuthRouteError(409, 'DINGTALK_EMAIL_ALREADY_EXISTS', 'A MetaSheet account with the same email already exists; bind it manually first', {
      email,
    })
  }

  const userId = randomUUID()
  const passwordHash = await hash(`Dt-${randomUUID()}-Aa9`, Number(process.env.BCRYPT_SALT_ROUNDS || 10))
  const role = preset?.role || 'user'
  const roleId = preset?.roleId || ''
  const directPermissions = Array.from(new Set(preset?.permissions || []))

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, TRUE, $7, NOW(), NOW())`,
      [userId, email, name, passwordHash, role, JSON.stringify(directPermissions), role === 'admin'],
    )

    await client.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active, created_at)
       VALUES ($1, $2, TRUE, NOW())
       ON CONFLICT (user_id, org_id) DO NOTHING`,
      [userId, provisioning.autoProvisionOrgId],
    )

    if (roleId) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, roleId],
      )
    }

    if (directPermissions.length > 0) {
      const values = directPermissions.map((_, index) => `($1, $${index + 2})`).join(', ')
      await client.query(
        `INSERT INTO user_permissions (user_id, permission_code)
         VALUES ${values}
         ON CONFLICT DO NOTHING`,
        [userId, ...directPermissions],
      )
    }
  })

  const binding = await upsertExternalIdentity({
    provider: 'dingtalk',
    externalKey,
    providerUserId: profile.userId,
    providerUnionId: profile.unionId,
    providerOpenId: profile.openId,
    corpId: corpId || null,
    userId,
    profile: profile.raw,
    boundBy: null,
  })
  if (!binding) {
    throw new AuthRouteError(500, 'DINGTALK_BINDING_CREATE_FAILED', 'Failed to persist DingTalk identity binding')
  }

  await auditLog({
    actorType: 'system',
    action: 'dingtalk-auto-provision',
    resourceType: 'user',
    resourceId: userId,
    meta: {
      provider: 'dingtalk',
      corpId: corpId || null,
      externalKey,
      email,
      presetId: preset?.id || null,
      orgId: provisioning.autoProvisionOrgId,
    },
  })

  const user = await loadCanonicalUser(userId)
  if (!user) {
    throw new AuthRouteError(500, 'DINGTALK_USER_LOAD_FAILED', 'Provisioned user could not be loaded')
  }

  return {
    user,
    binding,
    onboarding: buildOnboardingPacket({
      email,
      temporaryPassword: null,
      preset,
      inviteToken: null,
    }),
  }
}

async function ensureUserCanUseDingTalk(userId: string, mode: 'bind' | 'login'): Promise<void> {
  const allowed = await isUserExternalAuthEnabled(userId, 'dingtalk')
  if (allowed) return

  if (mode === 'bind') {
    throw new AuthRouteError(
      403,
      'DINGTALK_BIND_NOT_AUTHORIZED',
      'This MetaSheet account is not authorized to bind DingTalk login',
    )
  }

  throw new AuthRouteError(
    403,
    'DINGTALK_LOGIN_NOT_AUTHORIZED',
    'This MetaSheet account is not authorized to use DingTalk login',
  )
}

async function completeDingTalkExchange(req: Request, state: DingTalkAuthState, profile: DingTalkIdentityProfile): Promise<DingTalkExchangeResult> {
  const existing = await findDingTalkExternalIdentity(profile)
  const redirect = sanitizeRedirectPath(state.redirect)

  if (state.mode === 'bind') {
    const currentUser = await getAuthenticatedUserFromRequest(req)
    if (!currentUser) {
      throw new AuthRouteError(401, 'UNAUTHORIZED', 'Authentication required to bind DingTalk account')
    }
    if (state.requestedBy && currentUser.id !== state.requestedBy) {
      throw new AuthRouteError(403, 'DINGTALK_BIND_MISMATCH', 'DingTalk bind session does not match the authenticated user')
    }
    await ensureUserCanUseDingTalk(currentUser.id, 'bind')
    if (existing && existing.userId !== currentUser.id) {
      throw new AuthRouteError(409, 'DINGTALK_ALREADY_BOUND', 'This DingTalk account is already bound to another user')
    }

    const currentBindings = await listUserExternalIdentities(currentUser.id, 'dingtalk')
    const hasDifferentBinding = currentBindings.some((binding) => binding.id !== existing?.id)
    if (hasDifferentBinding) {
      throw new AuthRouteError(409, 'DINGTALK_BIND_EXISTS_FOR_USER', 'Current user already has a different DingTalk binding')
    }

    const externalKey = existing?.externalKey || buildDingTalkExternalKey(profile)
    if (!externalKey) {
      throw new AuthRouteError(422, 'DINGTALK_IDENTITY_INCOMPLETE', 'DingTalk profile did not contain a stable identity key')
    }

    const binding = await upsertExternalIdentity({
      provider: 'dingtalk',
      externalKey,
      providerUserId: profile.userId,
      providerUnionId: profile.unionId,
      providerOpenId: profile.openId,
      corpId: profile.corpId,
      userId: currentUser.id,
      profile: profile.raw,
      boundBy: currentUser.id,
    })
    if (!binding) {
      throw new AuthRouteError(500, 'DINGTALK_BIND_FAILED', 'Failed to bind DingTalk account')
    }

    await auditLog({
      actorId: currentUser.id,
      actorType: 'user',
      action: 'dingtalk-bind',
      resourceType: 'user-external-identity',
      resourceId: binding.id,
      meta: {
        provider: 'dingtalk',
        corpId: profile.corpId,
        externalKey,
      },
    })

    return {
      user: currentUser,
      binding,
      redirect,
      features: deriveProductFeatures(currentUser),
      provisioned: false,
    }
  }

  if (existing) {
    const user = await loadCanonicalUser(existing.userId)
    if (!user) {
      throw new AuthRouteError(404, 'DINGTALK_BOUND_USER_NOT_FOUND', 'The DingTalk binding points to a missing user')
    }
    await ensureUserCanUseDingTalk(user.id, 'login')
    await touchExternalIdentityLogin(existing.id)
    const { token } = await issueAuthenticatedSession(user, req, { authProvider: 'dingtalk' })
    return {
      user,
      binding: existing,
      token,
      redirect,
      features: deriveProductFeatures(user),
      provisioned: false,
    }
  }

  const provisioned = await autoProvisionDingTalkUser(profile)
  const { token } = await issueAuthenticatedSession(provisioned.user, req, { authProvider: 'dingtalk' })
  return {
    user: provisioned.user,
    binding: provisioned.binding,
    token,
    redirect,
    features: deriveProductFeatures(provisioned.user),
    provisioned: true,
    onboarding: provisioned.onboarding,
  }
}

function isAuthRouteError(error: unknown): error is AuthRouteError {
  return error instanceof AuthRouteError
}

// ============================================
// Dev Token (non-production only)
// ============================================

const DEV_FALLBACK_JWT_SECRET = 'fallback-development-secret-change-in-production'

authRouter.get('/dev-token', (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, error: 'Not found' })
  }

  const userId = typeof req.query.userId === 'string' && req.query.userId.trim() ? req.query.userId.trim() : 'dev-user'
  const rolesParam = typeof req.query.roles === 'string' ? req.query.roles : 'admin'
  const permsParam = typeof req.query.perms === 'string'
    ? req.query.perms
    : 'permissions:read,permissions:write,approvals:read,approvals:write,comments:read,comments:write'
  const expiresIn = (typeof req.query.expiresIn === 'string' && req.query.expiresIn.trim()
    ? req.query.expiresIn.trim()
    : '2h') as SignOptions['expiresIn']

  const roles = rolesParam.split(',').map((v) => v.trim()).filter(Boolean)
  const perms = permsParam.split(',').map((v) => v.trim()).filter(Boolean)

  const secret = process.env.JWT_SECRET || DEV_FALLBACK_JWT_SECRET

  const payload = {
    id: userId,
    roles: roles.length > 0 ? roles : ['admin'],
    perms,
  }

  const token = jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn })

  return res.json({ token, payload })
})

// ============================================
// Rate Limiting for Auth Endpoints
// ============================================
interface RateLimitEntry {
  count: number
  resetTime: number
  blocked: boolean
  blockExpires?: number
}

const rateLimitStore = new Map<string, RateLimitEntry>()

export function resetAuthRouteRateLimitsForTests(): void {
  rateLimitStore.clear()
}

// Configuration
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000  // 15 minutes
const MAX_LOGIN_ATTEMPTS = 5                   // Max failed attempts
const BLOCK_DURATION_MS = 30 * 60 * 1000      // 30 minutes block
const MAX_REGISTER_PER_IP = 3                  // Max registrations per IP per window
const MAX_DINGTALK_LOGIN_URL_PER_IP = 20       // Max DingTalk login-url requests per IP per window
const MAX_DINGTALK_EXCHANGE_PER_IP = 10        // Max DingTalk code exchange attempts per IP per window

function getClientIP(req: Request): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim()
  }
  return req.ip || req.socket.remoteAddress || 'unknown'
}

function checkRateLimit(key: string, maxAttempts: number): { allowed: boolean; retryAfter?: number } {
  const now = Date.now()
  const entry = rateLimitStore.get(key)

  // Check if blocked
  if (entry?.blocked && entry.blockExpires && entry.blockExpires > now) {
    return { allowed: false, retryAfter: Math.ceil((entry.blockExpires - now) / 1000) }
  }

  // Reset if window expired
  if (!entry || entry.resetTime < now) {
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW_MS,
      blocked: false
    })
    return { allowed: true }
  }

  // Increment and check
  entry.count++
  if (entry.count > maxAttempts) {
    entry.blocked = true
    entry.blockExpires = now + BLOCK_DURATION_MS
    logger.warn(`Blocking ${key} for ${BLOCK_DURATION_MS / 1000}s after ${entry.count} attempts`)
    return { allowed: false, retryAfter: Math.ceil(BLOCK_DURATION_MS / 1000) }
  }

  return { allowed: true }
}

function resetRateLimit(key: string): void {
  rateLimitStore.delete(key)
}

// Rate limit middleware for login
const loginRateLimiter = (req: Request, res: Response, next: NextFunction) => {
  const ip = getClientIP(req)
  const email = req.body?.email?.toLowerCase() || ''
  const key = `login:${ip}:${email}`

  const result = checkRateLimit(key, MAX_LOGIN_ATTEMPTS)
  if (!result.allowed) {
    logger.warn(`Rate limit exceeded for login: ${ip} / ${email}`)
    return res.status(429).json({
      success: false,
      error: 'Too many login attempts. Please try again later.',
      retryAfter: result.retryAfter
    })
  }
  next()
}

// Rate limit middleware for registration
const registerRateLimiter = (req: Request, res: Response, next: NextFunction) => {
  const ip = getClientIP(req)
  const key = `register:${ip}`

  const result = checkRateLimit(key, MAX_REGISTER_PER_IP)
  if (!result.allowed) {
    logger.warn(`Rate limit exceeded for registration: ${ip}`)
    return res.status(429).json({
      success: false,
      error: 'Too many registration attempts. Please try again later.',
      retryAfter: result.retryAfter
    })
  }
  next()
}

const dingTalkLoginUrlRateLimiter = (req: Request, res: Response, next: NextFunction) => {
  const ip = getClientIP(req)
  const key = `dingtalk-login-url:${ip}`
  const result = checkRateLimit(key, MAX_DINGTALK_LOGIN_URL_PER_IP)
  if (!result.allowed) {
    logger.warn(`Rate limit exceeded for DingTalk login-url: ${ip}`)
    return res.status(429).json({
      success: false,
      error: 'Too many DingTalk login attempts. Please try again later.',
      retryAfter: result.retryAfter,
    })
  }
  next()
}

const dingTalkExchangeRateLimiter = (req: Request, res: Response, next: NextFunction) => {
  const ip = getClientIP(req)
  const key = `dingtalk-exchange:${ip}`
  const result = checkRateLimit(key, MAX_DINGTALK_EXCHANGE_PER_IP)
  if (!result.allowed) {
    logger.warn(`Rate limit exceeded for DingTalk exchange: ${ip}`)
    return res.status(429).json({
      success: false,
      error: 'Too many DingTalk authorization attempts. Please try again later.',
      retryAfter: result.retryAfter,
    })
  }
  next()
}

// ============================================
// Password Validation
// ============================================
interface PasswordValidation {
  valid: boolean
  errors: string[]
}

function validatePassword(password: string): PasswordValidation {
  const errors: string[] = []

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long')
  }
  if (password.length > 128) {
    errors.push('Password must not exceed 128 characters')
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter')
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter')
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number')
  }
  // Check for common weak patterns
  const weakPatterns = ['password', '123456', 'qwerty', 'abc123', 'letmein', 'admin']
  if (weakPatterns.some(p => password.toLowerCase().includes(p))) {
    errors.push('Password contains a common weak pattern')
  }

  return { valid: errors.length === 0, errors }
}

// ============================================
// Input Sanitization
// ============================================
function sanitizeEmail(email: string): string {
  return email.trim().toLowerCase().slice(0, 255)
}

function sanitizeName(name: string): string {
  // Remove potentially dangerous characters, keep letters, numbers, spaces
  return name.trim().replace(/[<>'"&;]/g, '').slice(0, 100)
}

/**
 * 用户登录
 * Protected by rate limiting: 5 attempts per 15 minutes
 */
authRouter.post('/login', loginRateLimiter, async (req: Request, res: Response) => {
  const ip = getClientIP(req)

  try {
    const { email, password } = req.body

    // 验证请求参数
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      })
    }

    // Sanitize email
    const cleanEmail = sanitizeEmail(email)

    // 尝试登录
    const result = await authService.login(cleanEmail, password)

    if (!result) {
      logger.warn(`Failed login attempt for ${cleanEmail} from ${ip}`)
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      })
    }

    // Success - reset rate limit
    resetRateLimit(`login:${ip}:${cleanEmail}`)
    logger.info(`Successful login for ${cleanEmail} from ${ip}`)
    const session = await issueAuthenticatedSession(result.user, req, { authProvider: 'password' })

    // 返回用户信息和token
    res.json({
      success: true,
      data: {
        user: result.user,
        token: session.token,
        features: deriveProductFeatures(result.user),
      }
    })
  } catch (error) {
    logger.error('Login error', error instanceof Error ? error : undefined)
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})

/**
 * 用户注册
 * Protected by rate limiting: 3 registrations per IP per 15 minutes
 */
authRouter.post('/register', registerRateLimiter, async (req: Request, res: Response) => {
  const ip = getClientIP(req)

  try {
    const { email, password, name } = req.body

    // 验证请求参数
    if (!email || !password || !name) {
      return res.status(400).json({
        success: false,
        error: 'Email, password, and name are required'
      })
    }

    // Sanitize inputs
    const cleanEmail = sanitizeEmail(email)
    const cleanName = sanitizeName(name)

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      })
    }

    // Strong password validation
    const passwordValidation = validatePassword(password)
    if (!passwordValidation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Password does not meet requirements',
        details: passwordValidation.errors
      })
    }

    // Validate name
    if (cleanName.length < 2 || cleanName.length > 100) {
      return res.status(400).json({
        success: false,
        error: 'Name must be between 2 and 100 characters'
      })
    }

    // 尝试注册
    const user = await authService.register(cleanEmail, password, cleanName)

    if (!user) {
      logger.warn(`Registration attempt with existing email: ${cleanEmail} from ${ip}`)
      return res.status(409).json({
        success: false,
        error: 'User with this email already exists'
      })
    }

    // 注册成功，自动生成token
    const session = await issueAuthenticatedSession(user, req, { authProvider: 'password' })
    logger.info(`Successful registration for ${cleanEmail} from ${ip}`)

    res.status(201).json({
      success: true,
      data: {
        user,
        token: session.token
      }
    })
  } catch (error) {
    logger.error('Registration error', error instanceof Error ? error : undefined)
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})

authRouter.get('/dingtalk/login-url', dingTalkLoginUrlRateLimiter, async (req: Request, res: Response) => {
  try {
    if (!dingTalkAuthService.isConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'DingTalk auth is not configured'
      })
    }

    const redirect = sanitizeRedirectPath(req.query.redirect)
    const payload = dingTalkAuthService.buildAuthorizeUrl({
      mode: 'login',
      redirect,
    })

    return res.json({
      success: true,
      data: {
        provider: 'dingtalk',
        url: payload.url,
        loginUrl: payload.url,
        state: payload.state,
        redirect: payload.redirect,
      },
    })
  } catch (error) {
    logger.error('DingTalk login-url error', error instanceof Error ? error : undefined)
    return res.status(500).json({
      success: false,
      error: 'Failed to prepare DingTalk login URL',
    })
  }
})

authRouter.post('/dingtalk/bind/start', async (req: Request, res: Response) => {
  try {
    if (!dingTalkAuthService.isConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'DingTalk auth is not configured'
      })
    }

    const user = await getAuthenticatedUserFromRequest(req)
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      })
    }
    await ensureUserCanUseDingTalk(user.id, 'bind')

    const redirect = sanitizeRedirectPath(req.body?.redirect || req.query.redirect)
    const payload = dingTalkAuthService.buildAuthorizeUrl({
      mode: 'bind',
      redirect,
      requestedBy: user.id,
    })

    return res.json({
      success: true,
      data: {
        provider: 'dingtalk',
        url: payload.url,
        bindUrl: payload.url,
        state: payload.state,
        redirect: payload.redirect,
      },
    })
  } catch (error) {
    if (isAuthRouteError(error)) {
      return res.status(error.status).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      })
    }
    logger.error('DingTalk bind-start error', error instanceof Error ? error : undefined)
    return res.status(500).json({
      success: false,
      error: 'Failed to prepare DingTalk bind URL',
    })
  }
})

authRouter.post('/dingtalk/exchange', dingTalkExchangeRateLimiter, async (req: Request, res: Response) => {
  try {
    if (!dingTalkAuthService.isConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'DingTalk auth is not configured'
      })
    }

    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : ''
    const stateValue = typeof req.body?.state === 'string' ? req.body.state.trim() : ''
    if (!code || !stateValue) {
      return res.status(400).json({
        success: false,
        error: 'code and state are required'
      })
    }

    const state = dingTalkAuthService.verifyState(stateValue)
    if (!state) {
      return res.status(400).json({
        success: false,
        error: 'Invalid DingTalk auth state'
      })
    }

    const profile = await dingTalkAuthService.exchangeCode(code)
    const result = await completeDingTalkExchange(req, state, profile)

    return res.json({
      success: true,
      data: {
        provider: 'dingtalk',
        mode: state.mode,
        redirect: result.redirect,
        redirectUrl: result.redirect,
        user: result.user,
        token: result.token,
        binding: result.binding,
        features: result.features,
        provisioned: result.provisioned,
        onboarding: result.onboarding,
      },
    })
  } catch (error) {
    if (isAuthRouteError(error)) {
      return res.status(error.status).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      })
    }

    if (isDingTalkAuthExchangeError(error)) {
      logger.warn('DingTalk exchange upstream error', error)
      return res.status(error.status >= 400 && error.status < 500 ? 400 : 502).json({
        success: false,
        error: {
          code: 'DINGTALK_EXCHANGE_FAILED',
          message: error.message,
          details: {
            provider: 'dingtalk',
            stage: error.stage,
            upstreamStatus: error.status,
            ...(error.details ? error.details : {}),
          },
        },
      })
    }

    logger.error('DingTalk exchange error', error instanceof Error ? error : undefined)
    return res.status(500).json({
      success: false,
      error: 'Failed to complete DingTalk authentication',
    })
  }
})

authRouter.get('/dingtalk/bindings', async (req: Request, res: Response) => {
  try {
    const user = await getAuthenticatedUserFromRequest(req)
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      })
    }

    const items = await listUserExternalIdentities(user.id, 'dingtalk')
    const authEnabled = await isUserExternalAuthEnabled(user.id, 'dingtalk')
    return res.json({
      success: true,
      data: {
        items,
        authEnabled,
      },
    })
  } catch (error) {
    logger.error('DingTalk bindings list error', error instanceof Error ? error : undefined)
    return res.status(500).json({
      success: false,
      error: 'Failed to load DingTalk bindings',
    })
  }
})

authRouter.post('/dingtalk/bindings/:provider/:bindingId/unbind', async (req: Request, res: Response) => {
  try {
    const provider = String(req.params.provider || '').trim()
    const bindingId = String(req.params.bindingId || '').trim()
    const user = await getAuthenticatedUserFromRequest(req)
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      })
    }
    if (provider !== 'dingtalk' || !bindingId) {
      return res.status(400).json({
        success: false,
        error: 'provider and bindingId are required'
      })
    }

    const removed = await deleteUserExternalIdentity(user.id, 'dingtalk', bindingId)
    if (!removed) {
      return res.status(404).json({
        success: false,
        error: 'Binding not found'
      })
    }

    await auditLog({
      actorId: user.id,
      actorType: 'user',
      action: 'dingtalk-unbind',
      resourceType: 'user-external-identity',
      resourceId: bindingId,
      meta: {
        provider,
        externalKey: removed.externalKey,
      },
    })

    return res.json({
      success: true,
      data: {
        item: removed,
      },
    })
  } catch (error) {
    logger.error('DingTalk unbind error', error instanceof Error ? error : undefined)
    return res.status(500).json({
      success: false,
      error: 'Failed to unbind DingTalk account',
    })
  }
})

/**
 * Token刷新
 */
authRouter.post('/refresh-token', async (req: Request, res: Response) => {
  try {
    const { token } = req.body

    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Token is required'
      })
    }

    // 刷新token
    const newToken = await authService.refreshToken(token)

    if (!newToken) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      })
    }

    const refreshedPayload = authService.readTokenPayload(newToken)
    const refreshedSid = typeof refreshedPayload?.sid === 'string' ? refreshedPayload.sid.trim() : ''
    const refreshedExp = typeof refreshedPayload?.exp === 'number' ? refreshedPayload.exp : 0
    if (refreshedSid && refreshedExp > 0) {
      await refreshUserSessionExpiry(refreshedSid, new Date(refreshedExp * 1000).toISOString())
    }

    res.json({
      success: true,
      data: {
        token: newToken
      }
    })
  } catch (error) {
    logger.error('Token refresh error', error instanceof Error ? error : undefined)
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})

/**
 * 验证token (用于客户端检查token有效性)
 */
authRouter.get('/verify', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      })
    }

    // 验证token
    const user = await authService.verifyToken(token)

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      })
    }

    res.json({
      success: true,
      data: { user }
    })
  } catch (error) {
    logger.error('Token verification error', error instanceof Error ? error : undefined)
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})

/**
 * 邀请预览
 */
authRouter.get('/invite/preview', async (req: Request, res: Response) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token.trim() : ''

    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Invite token is required'
      })
    }

    const invitePayload = verifyInviteToken(token)
    if (!invitePayload) {
      return res.status(400).json({
        success: false,
        error: 'Invalid invite token'
      })
    }

    const userRows = await query<InviteUserRecord>(
      'SELECT id, email, name, is_active, updated_at FROM users WHERE id = $1',
      [invitePayload.userId],
    )
    const user = userRows.rows[0]
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Invite user not found'
      })
    }

    const preset = getAccessPreset(invitePayload.presetId)
    const onboarding = buildOnboardingPacket({
      email: user.email,
      temporaryPassword: null,
      preset,
      inviteToken: token,
    })

    res.json({
      success: true,
      data: {
        user: mapInviteUserPayload(user),
        onboarding,
      }
    })
  } catch (error) {
    logger.error('Invite preview error', error instanceof Error ? error : undefined)
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})

/**
 * 接受邀请并设置密码
 */
authRouter.post('/invite/accept', async (req: Request, res: Response) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    const name = typeof req.body?.name === 'string' ? sanitizeName(req.body.name) : ''

    if (!token || !password) {
      return res.status(400).json({
        success: false,
        error: 'Token and password are required'
      })
    }

    const invitePayload = verifyInviteToken(token)
    if (!invitePayload) {
      return res.status(400).json({
        success: false,
        error: 'Invalid invite token'
      })
    }

    const passwordValidation = validatePassword(password)
    if (!passwordValidation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Password does not meet requirements',
        details: passwordValidation.errors,
      })
    }

    const userRows = await query<InviteUserRecord>(
      'SELECT id, email, name, is_active, updated_at FROM users WHERE id = $1',
      [invitePayload.userId],
    )
    const user = userRows.rows[0]
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Invite user not found'
      })
    }

    const hashedPassword = await hash(password, Number(process.env.BCRYPT_SALT_ROUNDS || 10))
    await query<{ rowCount: number }>(
      'UPDATE users SET password_hash = $1, name = $2, is_active = TRUE, updated_at = NOW() WHERE id = $3 AND email = $4',
      [hashedPassword, name || user.name, user.id, user.email]
    )

    const inviteRows = await query<InviteLedgerRecord>(
      `UPDATE user_invites
       SET status = 'accepted', accepted_at = NOW(), consumed_by = $2, updated_at = NOW()
       WHERE id = (SELECT id FROM user_invites WHERE invite_token = $1 ORDER BY updated_at DESC LIMIT 1)
       RETURNING id, user_id, email, preset_id, product_mode, role_id, invited_by, invite_token, status, accepted_at, consumed_by, last_sent_at, created_at, updated_at`,
      [token, user.id],
    )
    const ledger = inviteRows.rows[0]

    const preset = getAccessPreset(ledger?.preset_id || invitePayload.presetId)
    const onboarding = buildOnboardingPacket({
      email: user.email,
      temporaryPassword: null,
      preset,
      inviteToken: token,
    })

    const result = await (authService.login as (email: string, password: string, options?: { ipAddress: string }) => Promise<{
      user: User
      token: string
    } | null>)(user.email, password, {
      ipAddress: getClientIP(req),
    })
    if (!result) {
      return res.status(401).json({
        success: false,
        error: 'Failed to login after invite acceptance'
      })
    }

    await revokeUserSessions(user.id, {
      updatedBy: user.id,
      reason: 'invite-accepted',
    })
    const session = await issueAuthenticatedSession(result.user, req, { authProvider: 'password' })

    res.json({
      success: true,
      data: {
        ...result,
        token: session.token,
        onboarding,
        features: deriveProductFeatures(result.user),
      }
    })
  } catch (error) {
    logger.error('Invite accept error', error instanceof Error ? error : undefined)
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})

/**
 * 用户信息接口 (需要认证)
 */
authRouter.get('/me', async (req: Request, res: Response) => {
  try {
    const token = extractBearerToken(req)

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      })
    }

    const user = await authService.verifyToken(token)

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      })
    }

    const authUser = user as User
    const features = deriveProductFeatures(authUser)

    res.json({
      success: true,
      data: {
        user: authUser,
        features,
      }
    })
  } catch (error) {
    logger.error('Get user info error', error instanceof Error ? error : undefined)
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})

/**
 * 当前会话用户会话列表
 */
authRouter.get('/sessions', async (req: Request, res: Response) => {
  try {
    const token = extractBearerToken(req)

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      })
    }

    const user = await authService.verifyToken(token)
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      })
    }

    const tokenPayload = authService.readTokenPayload(token) as SessionTokenPayload | null
    const userId = extractUserIdFromPayload(tokenPayload, user as User)
    const currentSessionId = normalizeSessionId(tokenPayload?.sid)

    const items = await listUserSessions(userId)

    res.json({
      success: true,
      data: {
        currentSessionId,
        items,
      }
    })
  } catch (error) {
    logger.error('List sessions error', error instanceof Error ? error : undefined)
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})

/**
 * 结束指定会话
 */
authRouter.post('/sessions/:sessionId/logout', async (req: Request, res: Response) => {
  try {
    const token = extractBearerToken(req)

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      })
    }

    const user = await authService.verifyToken(token)
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      })
    }

    const rawSessionId = String(req.params.sessionId || '').trim()
    if (!rawSessionId) {
      return res.status(400).json({
        success: false,
        error: 'Session ID is required'
      })
    }

    const session = await getUserSession(rawSessionId)
    if (!session || session.userId !== user.id) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      })
    }

    const revoked = await revokeUserSession(rawSessionId, {
      revokedBy: user.id,
      reason: 'self-session-logout',
    })

    res.json({
      success: true,
      data: {
        sessionId: revoked?.id || rawSessionId,
      }
    })
  } catch (error) {
    logger.error('Revoke session error', error instanceof Error ? error : undefined)
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})

/**
 * 上报当前会话心跳
 */
authRouter.post('/sessions/current/ping', async (req: Request, res: Response) => {
  try {
    const token = extractBearerToken(req)

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      })
    }

    const user = await authService.verifyToken(token)
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      })
    }

    const tokenPayload = authService.readTokenPayload(token) as SessionTokenPayload | null
    const sessionId = normalizeSessionId(tokenPayload?.sid)
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Current session is unavailable'
      })
    }

    const ipAddress = getClientIP(req)
    const userAgent = typeof req.headers['user-agent'] === 'string'
      ? req.headers['user-agent']
      : ''

    const touched = await touchUserSession(sessionId, {
      ipAddress,
      userAgent,
      minIntervalMs: 60_000,
    })

    const session = touched ?? await getUserSession(sessionId)

    res.json({
      success: true,
      data: {
        sessionId,
        session,
        lastSeenAt: session?.lastSeenAt ?? null,
      }
    })
  } catch (error) {
    logger.error('Ping session error', error instanceof Error ? error : undefined)
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})

/**
 * 会话退出（当前会话优先）
 */
authRouter.post('/logout', async (req: Request, res: Response) => {
  try {
    const token = extractBearerToken(req)

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      })
    }

    const user = await authService.verifyToken(token)
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      })
    }

    const tokenPayload = authService.readTokenPayload(token) as SessionTokenPayload | null
    const currentSessionId = normalizeSessionId(tokenPayload?.sid)

    if (currentSessionId) {
      const revoked = await revokeUserSession(currentSessionId, {
        revokedBy: user.id,
        reason: 'self-logout',
      })
      if (revoked) {
        return res.json({
          success: true,
          data: {
            scope: 'current-session',
            sessionId: revoked.id,
          }
        })
      }
    }

    const revokedAll = await revokeUserSessions(user.id, {
      updatedBy: user.id,
      reason: 'self-logout',
    })

    res.json({
      success: true,
      data: {
        scope: 'all-sessions',
        revokedAfter: revokedAll?.revokedAfter ?? null,
      }
    })
  } catch (error) {
    logger.error('Logout error', error instanceof Error ? error : undefined)
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})

/**
 * 结束其他会话
 */
authRouter.post('/sessions/others/logout', async (req: Request, res: Response) => {
  try {
    const token = extractBearerToken(req)

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      })
    }

    const user = await authService.verifyToken(token)
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      })
    }

    const tokenPayload = authService.readTokenPayload(token) as SessionTokenPayload | null
    const currentSessionId = normalizeSessionId(tokenPayload?.sid)
    if (!currentSessionId) {
      return res.status(400).json({
        success: false,
        error: 'Current session is unavailable'
      })
    }

    const revokedCount = await revokeOtherUserSessions(user.id, currentSessionId, {
      revokedBy: user.id,
      reason: 'self-other-sessions-logout',
    })

    res.json({
      success: true,
      data: {
        currentSessionId,
        revokedCount,
      }
    })
  } catch (error) {
    logger.error('Revoke other sessions error', error instanceof Error ? error : undefined)
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})
