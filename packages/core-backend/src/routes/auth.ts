/**
 * 认证路由
 * 提供登录、注册、token刷新等认证服务
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import jwt, { type SignOptions } from 'jsonwebtoken'
import { authService, type User } from '../auth/AuthService'
import { buildOnboardingPacket, getAccessPreset } from '../auth/access-presets'
import {
  bindDingTalkIdentityToUser,
  buildAuthUrl,
  DingTalkLoginPolicyError,
  exchangeCodeForDingTalkProfile,
  exchangeCodeForUser,
  getDingTalkRuntimeStatus,
  generateState,
  isDingTalkConfigured,
  validateState,
} from '../auth/dingtalk-oauth'
import { markInviteAccepted } from '../auth/invite-ledger'
import { verifyInviteToken } from '../auth/invite-tokens'
import { validatePassword } from '../auth/password-policy'
import { createUserSession, getUserSession, listUserSessions, revokeUserSession, touchUserSession } from '../auth/session-registry'
import { revokeUserSessions } from '../auth/session-revocation'
import { FEATURE_FLAGS } from '../config/flags'
import { Logger } from '../core/logger'
import { extractTenantFromHeaders } from '../db/sharding/tenant-context'
import { query } from '../db/pg'
import { listUserPermissions } from '../rbac/service'
import { secretManager } from '../security/SecretManager'
import { isPlmEnabled, resolveEffectiveProductMode } from '../config/product-mode'
import { getBcryptSaltRounds, resolveRuntimeJwtSecret } from '../security/auth-runtime-config'
import { DingTalkRequestError } from '../integrations/dingtalk/client'

const logger = new Logger('AuthRouter')

export const authRouter = Router()

// ============================================
// Dev Token (non-production only)
// ============================================

authRouter.get('/dev-token', async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, error: 'Not found' })
  }

  const userId = typeof req.query.userId === 'string' && req.query.userId.trim() ? req.query.userId.trim() : 'dev-user'
  const tenantId =
    (typeof req.query.tenantId === 'string' && req.query.tenantId.trim() ? req.query.tenantId.trim() : undefined)
    || resolveRequestTenantId(req)
  const rolesParam = typeof req.query.roles === 'string' ? req.query.roles : 'admin'
  const permsParam = typeof req.query.perms === 'string'
    ? req.query.perms
    : '*:*'
  const expiresIn = (typeof req.query.expiresIn === 'string' && req.query.expiresIn.trim()
    ? req.query.expiresIn.trim()
    : '2h') as SignOptions['expiresIn']

  const roles = rolesParam.split(',').map((v) => v.trim()).filter(Boolean)
  const perms = permsParam.split(',').map((v) => v.trim()).filter(Boolean)

  const secret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))

  const payload = {
    id: userId,
    roles: roles.length > 0 ? roles : ['admin'],
    perms,
    ...(tenantId ? { tenantId } : {}),
    sid: randomUUID(),
  }

  const token = jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn })

  const decoded = jwt.decode(token) as { exp?: number } | null
  const expiresAt =
    typeof decoded?.exp === 'number'
      ? new Date(decoded.exp * 1000).toISOString()
      : new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()

  await createUserSession(userId, {
    sessionId: payload.sid,
    expiresAt,
    ipAddress: getClientIP(req),
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  })

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

// Configuration
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000  // 15 minutes
const MAX_LOGIN_ATTEMPTS = 5                   // Max failed attempts
const BLOCK_DURATION_MS = 30 * 60 * 1000      // 30 minutes block
const MAX_REGISTER_PER_IP = 3                  // Max registrations per IP per window

function getClientIP(req: Request): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim()
  }
  return req.ip || req.socket.remoteAddress || 'unknown'
}

function resolveRequestTenantId(req: Request): string | undefined {
  const headers = req.headers as Record<string, unknown> | undefined
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : undefined
  const query = req.query && typeof req.query === 'object' ? req.query as Record<string, unknown> : undefined
  const resolveString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  return (
    extractTenantFromHeaders(headers)
    || resolveString(headers?.['x-workspace-id'])
    || resolveString(body?.tenantId)
    || resolveString(body?.workspaceId)
    || resolveString(query?.tenantId)
    || resolveString(query?.workspaceId)
  )
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

function buildFeaturePayload(authUser: User) {
  const permissions = Array.isArray(authUser.permissions) ? authUser.permissions : []
  const attendance = authUser.role === 'admin' || permissions.some((permission) => permission.startsWith('attendance:'))
  const attendanceAdmin = authUser.role === 'admin' || permissions.includes('attendance:admin')
  const attendanceImport = attendanceAdmin || permissions.includes('attendance:write')
  const workflow = FEATURE_FLAGS.workflowEnabled
  const plm = isPlmEnabled(process.env.PRODUCT_MODE, process.env.ENABLE_PLM)
  const mode = resolveEffectiveProductMode(process.env.PRODUCT_MODE, process.env.ENABLE_PLM)

  return {
    attendance,
    workflow,
    attendanceAdmin,
    attendanceImport,
    plm,
    mode,
  }
}

function normalizeDingTalkRedirectPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || !normalized.startsWith('/') || normalized.startsWith('//')) return null
  if (normalized === '/' || normalized.startsWith('/login') || normalized.startsWith('/dingtalk')) return null
  return normalized
}

function isTruthyQueryFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

type DingTalkAccessSnapshot = {
  available: boolean
  userId: string
  provider: 'dingtalk'
  requireGrant: boolean
  autoLinkEmail: boolean
  autoProvision: boolean
  server: ReturnType<typeof getDingTalkRuntimeStatus>
  directory: {
    linked: boolean
    linkedCount: number
  }
  grant: {
    exists: boolean
    enabled: boolean
    grantedBy: string | null
    createdAt: string | null
    updatedAt: string | null
  }
  identity: {
    exists: boolean
    corpId: string | null
    lastLoginAt: string | null
    createdAt: string | null
    updatedAt: string | null
  }
}

async function requireAuthenticatedUser(req: Request, res: Response): Promise<{ token: string; user: User } | null> {
  const authHeader = req.headers.authorization
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null

  if (!token) {
    res.status(401).json({
      success: false,
      error: 'No token provided',
    })
    return null
  }

  const user = await authService.verifyToken(token)
  if (!user) {
    res.status(401).json({
      success: false,
      error: 'Invalid token',
    })
    return null
  }

  return { token, user }
}

async function fetchCurrentUserDingTalkAccessSnapshot(userId: string): Promise<DingTalkAccessSnapshot> {
  const [grantResult, identityResult, linkedDirectoryResult] = await Promise.all([
    query<{ enabled: boolean; granted_by: string | null; created_at: string | null; updated_at: string | null }>(
      `SELECT enabled, granted_by, created_at, updated_at
       FROM user_external_auth_grants
       WHERE provider = $1 AND local_user_id = $2
       LIMIT 1`,
      ['dingtalk', userId],
    ),
    query<{ corp_id: string | null; last_login_at: string | null; created_at: string | null; updated_at: string | null }>(
      `SELECT corp_id, last_login_at, created_at, updated_at
       FROM user_external_identities
       WHERE provider = $1 AND local_user_id = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      ['dingtalk', userId],
    ),
    query<{ linked_count: number | string }>(
      `SELECT COUNT(*)::int AS linked_count
       FROM directory_account_links l
       JOIN directory_accounts a ON a.id = l.directory_account_id
       WHERE l.local_user_id = $1
         AND l.link_status = 'linked'
         AND a.provider = $2`,
      [userId, 'dingtalk'],
    ),
  ])

  const runtime = getDingTalkRuntimeStatus()
  const grant = grantResult.rows[0] ?? null
  const identity = identityResult.rows[0] ?? null
  const linkedCount = Number(linkedDirectoryResult.rows[0]?.linked_count || 0)

  return {
    available: runtime.available,
    userId,
    provider: 'dingtalk',
    requireGrant: runtime.requireGrant,
    autoLinkEmail: runtime.autoLinkEmail,
    autoProvision: runtime.autoProvision,
    server: runtime,
    directory: {
      linked: linkedCount > 0,
      linkedCount,
    },
    grant: {
      exists: grant !== null,
      enabled: grant?.enabled === true,
      grantedBy: grant?.granted_by ?? null,
      createdAt: grant?.created_at ?? null,
      updatedAt: grant?.updated_at ?? null,
    },
    identity: {
      exists: identity !== null,
      corpId: identity?.corp_id ?? null,
      lastLoginAt: identity?.last_login_at ?? null,
      createdAt: identity?.created_at ?? null,
      updatedAt: identity?.updated_at ?? null,
    },
  }
}

async function loadAuthPermissions(userId: string): Promise<string[]> {
  try {
    return await listUserPermissions(userId)
  } catch (error) {
    logger.warn('Failed to load RBAC permissions for auth user', error instanceof Error ? error : undefined)
  }

  try {
    const result = await query<{ permissions: string[] | null }>(
      'SELECT permissions FROM users WHERE id = $1 LIMIT 1',
      [userId],
    )
    const permissions = result.rows[0]?.permissions
    return Array.isArray(permissions) ? permissions.map((permission) => String(permission)) : []
  } catch (error) {
    logger.warn('Failed to load legacy permissions for auth user', error instanceof Error ? error : undefined)
    return []
  }
}

async function issueAuthSessionToken(user: User, req: Request): Promise<string> {
  const sessionId = randomUUID()
  const tenantId = resolveRequestTenantId(req)
  const tokenUser = tenantId ? { ...user, tenantId } : user
  const token = authService.createToken(tokenUser, { sid: sessionId })
  const payload = authService.readTokenPayload(token)

  if (payload?.exp) {
    await createUserSession(user.id, {
      sessionId,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      ipAddress: getClientIP(req),
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    })
  }

  try {
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id])
  } catch (error) {
    logger.warn('Failed to update last_login_at after external auth login', error instanceof Error ? error : undefined)
  }

  return token
}

async function getInviteTarget(userId: string, email: string) {
  const result = await query<{ id: string; email: string; name: string | null; is_active: boolean; updated_at: string }>(
    `SELECT id, email, name, is_active, updated_at
     FROM users
     WHERE id = $1 AND email = $2`,
    [userId, email],
  )
  return result.rows[0] ?? null
}

function isInviteTokenConsumed(updatedAt: string, issuedAtSeconds?: number): boolean {
  if (!issuedAtSeconds) return false
  const updatedAtMs = new Date(updatedAt).getTime()
  if (!Number.isFinite(updatedAtMs)) return false
  return updatedAtMs > (issuedAtSeconds * 1000) + 1000
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
    const result = await authService.login(cleanEmail, password, {
      ipAddress: ip,
      userAgent: req.headers['user-agent'] || null,
      tenantId: resolveRequestTenantId(req),
    })

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

    // 返回用户信息和token
    res.json({
      success: true,
      data: {
        user: result.user,
        token: result.token,
        features: buildFeaturePayload(result.user),
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
    const tenantId = resolveRequestTenantId(req)
    const token = authService.createToken(tenantId ? { ...user, tenantId } : user)
    logger.info(`Successful registration for ${cleanEmail} from ${ip}`)

    res.status(201).json({
      success: true,
      data: {
        user,
        token
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

/**
 * 邀请链接预览
 */
authRouter.get('/invite/preview', async (req: Request, res: Response) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token.trim() : ''
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Invite token is required',
      })
    }

    const payload = verifyInviteToken(token)
    if (!payload) {
      return res.status(400).json({
        success: false,
        error: 'Invite token is invalid or expired',
      })
    }

    const target = await getInviteTarget(payload.userId, payload.email)
    if (!target) {
      return res.status(404).json({
        success: false,
        error: 'Invite target not found',
      })
    }

    if (isInviteTokenConsumed(target.updated_at, payload.iat)) {
      return res.status(409).json({
        success: false,
        error: 'Invite token has already been used',
      })
    }

    const preset = getAccessPreset(payload.presetId)
    return res.json({
      success: true,
      data: {
        user: {
          id: target.id,
          email: target.email,
          name: target.name,
          isActive: target.is_active,
        },
        onboarding: buildOnboardingPacket({
          email: payload.email,
          preset,
          temporaryPassword: null,
          inviteToken: token,
        }),
      },
    })
  } catch (error) {
    logger.error('Invite preview error', error instanceof Error ? error : undefined)
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    })
  }
})

/**
 * 接受邀请并完成首次密码设置
 */
authRouter.post('/invite/accept', async (req: Request, res: Response) => {
  try {
    const ip = getClientIP(req)
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
    const password = typeof req.body?.password === 'string' ? req.body.password.trim() : ''
    const requestedName = typeof req.body?.name === 'string' ? sanitizeName(req.body.name) : ''

    if (!token || !password) {
      return res.status(400).json({
        success: false,
        error: 'Invite token and password are required',
      })
    }

    const payload = verifyInviteToken(token)
    if (!payload) {
      return res.status(400).json({
        success: false,
        error: 'Invite token is invalid or expired',
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

    const target = await getInviteTarget(payload.userId, payload.email)
    if (!target) {
      return res.status(404).json({
        success: false,
        error: 'Invite target not found',
      })
    }

    if (isInviteTokenConsumed(target.updated_at, payload.iat)) {
      return res.status(409).json({
        success: false,
        error: 'Invite token has already been used',
      })
    }

    const passwordHash = await bcrypt.hash(password, getBcryptSaltRounds())
    await query(
      `UPDATE users
       SET password_hash = $1,
           is_active = true,
           name = COALESCE(NULLIF($2, ''), name),
           updated_at = NOW()
       WHERE id = $3 AND email = $4`,
      [passwordHash, requestedName, payload.userId, payload.email],
    )

    await revokeUserSessions(payload.userId, {
      updatedBy: payload.userId,
      reason: 'invite-accepted',
    })
    await markInviteAccepted(token, {
      consumedBy: payload.userId,
    })

    const result = await authService.login(payload.email, password, {
      ipAddress: ip,
      userAgent: req.headers['user-agent'] || null,
      tenantId: resolveRequestTenantId(req),
    })
    if (!result) {
      return res.status(500).json({
        success: false,
        error: 'Invite accepted but automatic login failed',
      })
    }

    const preset = getAccessPreset(payload.presetId)
    return res.json({
      success: true,
      data: {
        user: result.user,
        token: result.token,
        onboarding: buildOnboardingPacket({
          email: payload.email,
          preset,
          temporaryPassword: null,
          inviteToken: null,
        }),
        features: buildFeaturePayload(result.user),
      },
    })
  } catch (error) {
    logger.error('Invite acceptance error', error instanceof Error ? error : undefined)
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
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
 * 服务端注销当前账号所有会话
 */
authRouter.post('/logout', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null

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

    const payload = authService.readTokenPayload(token)
    const sessionId = typeof payload?.sid === 'string' && payload.sid.trim().length > 0 ? payload.sid.trim() : null
    const sessionRevocation = sessionId
      ? await revokeUserSession(sessionId, {
          revokedBy: user.id,
          reason: 'self-logout',
        })
      : null
    const revocation = sessionRevocation
      ? null
      : await revokeUserSessions(user.id, {
          updatedBy: user.id,
          reason: 'self-logout',
        })

    res.json({
      success: true,
      data: {
        userId: user.id,
        sessionId,
        revokedAfter: sessionRevocation?.revokedAt || revocation?.revokedAfter || null,
        scope: sessionRevocation ? 'current-session' : 'all-sessions',
      },
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
 * 列出当前账号的会话
 */
authRouter.get('/sessions', async (req: Request, res: Response) => {
  try {
    const authResult = await requireAuthenticatedUser(req, res)
    if (!authResult) return
    const { token, user } = authResult

    const payload = authService.readTokenPayload(token)
    const currentSessionId = typeof payload?.sid === 'string' && payload.sid.trim().length > 0 ? payload.sid.trim() : null
    const sessions = await listUserSessions(user.id)

    return res.json({
      success: true,
      data: {
        userId: user.id,
        currentSessionId,
        items: sessions,
      },
    })
  } catch (error) {
    logger.error('List sessions error', error instanceof Error ? error : undefined)
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})

/**
 * 更新当前会话的最近活跃时间
 */
authRouter.post('/sessions/current/ping', async (req: Request, res: Response) => {
  try {
    const authResult = await requireAuthenticatedUser(req, res)
    if (!authResult) return
    const { token, user } = authResult

    const payload = authService.readTokenPayload(token)
    const sessionId = typeof payload?.sid === 'string' && payload.sid.trim().length > 0 ? payload.sid.trim() : null
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Current session is unavailable'
      })
    }

    const touched = await touchUserSession(sessionId, {
      ipAddress: getClientIP(req),
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      minIntervalMs: 60_000,
    })
    const session = touched ?? await getUserSession(sessionId)

    return res.json({
      success: true,
      data: {
        userId: user.id,
        sessionId,
        session,
        lastSeenAt: session?.lastSeenAt || null,
      },
    })
  } catch (error) {
    logger.error('Current session ping error', error instanceof Error ? error : undefined)
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})

/**
 * 注销当前账号的指定会话
 */
authRouter.post('/sessions/:sessionId/logout', async (req: Request, res: Response) => {
  try {
    const authResult = await requireAuthenticatedUser(req, res)
    if (!authResult) return
    const { user } = authResult

    const sessionId = String(req.params.sessionId || '').trim()
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Session ID is required'
      })
    }

    const targetSession = await getUserSession(sessionId)
    if (!targetSession || targetSession.userId !== user.id) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      })
    }

    const revoked = await revokeUserSession(sessionId, {
      revokedBy: user.id,
      reason: 'self-session-logout',
    })

    return res.json({
      success: true,
      data: {
        userId: user.id,
        sessionId,
        revokedAt: revoked?.revokedAt || null,
      },
    })
  } catch (error) {
    logger.error('Logout session error', error instanceof Error ? error : undefined)
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})

authRouter.get('/dingtalk/access', async (req: Request, res: Response) => {
  try {
    const authResult = await requireAuthenticatedUser(req, res)
    if (!authResult) return

    const snapshot = await fetchCurrentUserDingTalkAccessSnapshot(authResult.user.id)
    return res.json({
      success: true,
      data: snapshot,
    })
  } catch (error) {
    logger.error('DingTalk access snapshot error', error instanceof Error ? error : undefined)
    return res.status(500).json({
      success: false,
      error: 'Failed to load DingTalk access status',
    })
  }
})

authRouter.post('/dingtalk/unbind', async (req: Request, res: Response) => {
  try {
    const authResult = await requireAuthenticatedUser(req, res)
    if (!authResult) return

    const snapshot = await fetchCurrentUserDingTalkAccessSnapshot(authResult.user.id)
    if (snapshot.directory.linked) {
      return res.status(409).json({
        success: false,
        error: 'Current DingTalk identity is directory-managed. Please contact an administrator.',
      })
    }

    await query(
      `DELETE FROM user_external_identities
       WHERE provider = $1 AND local_user_id = $2`,
      ['dingtalk', authResult.user.id],
    )

    const nextSnapshot = await fetchCurrentUserDingTalkAccessSnapshot(authResult.user.id)
    return res.json({
      success: true,
      data: nextSnapshot,
    })
  } catch (error) {
    logger.error('DingTalk self-unbind error', error instanceof Error ? error : undefined)
    return res.status(500).json({
      success: false,
      error: 'Failed to unbind DingTalk identity',
    })
  }
})

// ============================================
// DingTalk OAuth
// ============================================

authRouter.get('/dingtalk/launch', async (req: Request, res: Response) => {
  try {
    const runtimeStatus = getDingTalkRuntimeStatus()

    if (isTruthyQueryFlag(req.query.probe)) {
      return res.json({
        success: true,
        data: runtimeStatus,
      })
    }

    if (!runtimeStatus.available || !isDingTalkConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'DingTalk login is not configured on this server',
      })
    }

    const rawIntent = typeof req.query.intent === 'string' ? req.query.intent.trim().toLowerCase() : ''
    const mode: 'bind' | 'login' = rawIntent === 'bind' ? 'bind' : 'login'
    const redirectPath = normalizeDingTalkRedirectPath(req.query.redirect)

    let bindUserId: string | null = null
    if (mode === 'bind') {
      const authResult = await requireAuthenticatedUser(req, res)
      if (!authResult) return
      bindUserId = authResult.user.id
    }

    const state = await generateState(
      mode === 'bind'
        ? { redirectPath, intent: 'bind', bindUserId }
        : { redirectPath },
    )
    const url = buildAuthUrl(state)

    return res.json({
      success: true,
      data: {
        url,
        state,
        mode,
      },
    })
  } catch (error) {
    logger.error('DingTalk launch error', error instanceof Error ? error : undefined)
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to build DingTalk auth URL',
    })
  }
})

authRouter.post('/dingtalk/callback', async (req: Request, res: Response) => {
  try {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : ''
    const state = typeof req.body?.state === 'string' ? req.body.state.trim() : ''

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: code',
      })
    }

    const stateCheck = await validateState(state)
    if (!stateCheck.valid) {
      return res.status(400).json({
        success: false,
        error: stateCheck.error,
      })
    }

    if (!isDingTalkConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'DingTalk login is not configured on this server',
      })
    }

    if (stateCheck.intent === 'bind') {
      const authResult = await requireAuthenticatedUser(req, res)
      if (!authResult) return

      const expectedUserId = stateCheck.bindUserId || ''
      if (!expectedUserId || authResult.user.id !== expectedUserId) {
        return res.status(403).json({
          success: false,
          error: 'DingTalk bind session does not match the current user',
          code: 'bind_user_mismatch',
        })
      }

      // Directory-managed users must not self-rebind — their DingTalk identity
      // is owned by the admin directory sync flow.
      const preSnapshot = await fetchCurrentUserDingTalkAccessSnapshot(authResult.user.id)
      if (preSnapshot.directory.linked) {
        return res.status(409).json({
          success: false,
          error: 'Current user is directory-managed for DingTalk. Please contact an administrator to rebind.',
          code: 'directory_managed_conflict',
        })
      }

      const dtUser = await exchangeCodeForDingTalkProfile(code)
      await bindDingTalkIdentityToUser({
        localUserId: authResult.user.id,
        dtUser,
        boundBy: authResult.user.id,
        enableGrant: true,
      })

      const snapshot = await fetchCurrentUserDingTalkAccessSnapshot(authResult.user.id)

      logger.info(`DingTalk self-bind for ${authResult.user.email} (openId: ${dtUser.openId})`)

      return res.json({
        success: true,
        data: {
          mode: 'bind',
          bound: true,
          redirectPath: stateCheck.redirectPath || null,
          identity: snapshot,
        },
      })
    }

    const result = await exchangeCodeForUser(code)
    const permissions = await loadAuthPermissions(result.localUserId)
    const user: User = {
      id: result.localUserId,
      email: result.localUserEmail,
      name: result.localUserName,
      role: result.localUserRole,
      permissions,
      created_at: new Date(),
      updated_at: new Date(),
    }
    const token = await issueAuthSessionToken(user, req)

    logger.info(`DingTalk login for ${user.email} (openId: ${result.dingtalkUser.openId}, new: ${result.isNewUser})`)

    return res.json({
      success: true,
      data: {
        mode: 'login',
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          permissions: user.permissions,
        },
        token,
        redirectPath: stateCheck.redirectPath || null,
        features: buildFeaturePayload(user),
      },
    })
  } catch (error) {
    logger.error('DingTalk callback error', error instanceof Error ? error : undefined)
    const statusCode = error instanceof DingTalkLoginPolicyError
      ? error.statusCode
      : error instanceof DingTalkRequestError
        ? 502
        : 500
    const message = error instanceof DingTalkLoginPolicyError
      ? error.message
      : error instanceof DingTalkRequestError
        ? error.message
        : 'DingTalk authentication failed'

    return res.status(statusCode).json({
      success: false,
      error: message,
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
 * 用户信息接口 (需要认证)
 */
authRouter.get('/me', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null

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

    res.json({
      success: true,
      data: {
        user: authUser,
        features: buildFeaturePayload(authUser),
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
 * 管理员用户列表（兼容旧客户端 /api/auth/users）
 */
authRouter.get('/users', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      })
    }

    const payload = jwt.verify(token, resolveRuntimeJwtSecret(process.env.JWT_SECRET))
    if (!payload || typeof payload !== 'object') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      })
    }

    const tokenUser = payload as { role?: unknown; roles?: unknown }
    const roles = Array.isArray(tokenUser.roles) ? tokenUser.roles.map((value) => String(value)) : []
    const isAdmin = tokenUser.role === 'admin' || roles.includes('admin')
    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden'
      })
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1)
    const requestedPageSize = Number.parseInt(String(req.query.pageSize ?? '20'), 10) || 20
    const pageSize = Math.min(100, Math.max(1, requestedPageSize))
    const offset = (page - 1) * pageSize

    const term = q ? `%${q}%` : '%'
    const where = q ? 'WHERE email ILIKE $1 OR name ILIKE $1 OR id ILIKE $1' : ''
    const countSql = `SELECT COUNT(*)::int AS total FROM users ${where}`
    const listSql = `
      SELECT id, email, name, role, is_active, is_admin, last_login_at, created_at, updated_at
      FROM users
      ${where}
      ORDER BY created_at DESC
      LIMIT $${q ? 2 : 1} OFFSET $${q ? 3 : 2}
    `

    const countResult = await query<{ total: number }>(countSql, q ? [term] : undefined)
    const total = countResult.rows[0]?.total ?? 0
    const listParams = q ? [term, pageSize, offset] : [pageSize, offset]
    const listResult = await query(listSql, listParams)

    return res.json({
      success: true,
      data: {
        items: listResult.rows,
        total,
        page,
        pageSize,
      }
    })
  } catch (error) {
    logger.error('Get users error', error instanceof Error ? error : undefined)
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    })
  }
})
