/**
 * 认证路由
 * 提供登录、注册、token刷新等认证服务
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express'
import { hash } from 'bcryptjs'
import jwt, { type SignOptions } from 'jsonwebtoken'
import { authService, type User } from '../auth/AuthService'
import { buildOnboardingPacket, getAccessPreset } from '../auth/access-presets'
import { buildAuthUrl, exchangeCodeForUser, generateState, isDingTalkConfigured, validateState } from '../auth/dingtalk-oauth'
import { verifyInviteToken } from '../auth/invite-tokens'
import { getUserSession, listUserSessions, revokeOtherUserSessions, revokeUserSession, touchUserSession } from '../auth/session-registry'
import { revokeUserSessions } from '../auth/session-revocation'
import { query } from '../db/pg'
import { FEATURE_FLAGS } from '../config/flags'
import { Logger } from '../core/logger'

const logger = new Logger('AuthRouter')

export const authRouter = Router()

type ProductMode = 'platform' | 'attendance'

type ProductFeatures = {
  attendance: boolean
  workflow: boolean
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

    // 返回用户信息和token
    res.json({
      success: true,
      data: {
        user: result.user,
        token: result.token,
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
    const token = authService.createToken(user)
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

    res.json({
      success: true,
      data: {
        ...result,
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

// ============================================
// DingTalk OAuth
// ============================================

/**
 * GET /dingtalk/launch
 * Returns the DingTalk authorization URL for the frontend to redirect to.
 * If DingTalk env is not configured, returns 503 with a diagnostic message.
 */
authRouter.get('/dingtalk/launch', (_req: Request, res: Response) => {
  if (!isDingTalkConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'DingTalk login is not configured on this server',
    })
  }

  try {
    const state = generateState()
    const url = buildAuthUrl(state)
    res.json({ success: true, data: { url, state } })
  } catch (error) {
    logger.error('DingTalk launch error', error instanceof Error ? error : undefined)
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to build DingTalk auth URL',
    })
  }
})

/**
 * POST /dingtalk/callback
 * Exchanges the DingTalk auth code for a local user and JWT token.
 */
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

    const stateCheck = validateState(state)
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

    const result = await exchangeCodeForUser(code)

    // Build a User-compatible object for token creation and feature derivation
    const user: User = {
      id: result.localUserId,
      email: result.localUserEmail,
      name: result.localUserName,
      role: result.localUserRole,
      permissions: [],
      created_at: new Date(),
      updated_at: new Date(),
    }

    // Load actual permissions from DB if available
    try {
      const permRows = await query(
        `SELECT p.key FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = $1`,
        [user.id],
      )
      user.permissions = permRows.rows.map((r) => String((r as Record<string, unknown>).key || ''))
    } catch {
      // permissions table may not exist
    }

    const token = await authService.createToken(user, {})

    logger.info(`DingTalk login for ${result.localUserEmail} (openId: ${result.dingtalkUser.openId}, new: ${result.isNewUser})`)

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
        token,
        features: deriveProductFeatures(user),
      },
    })
  } catch (error) {
    logger.error('DingTalk callback error', error instanceof Error ? error : undefined)
    res.status(502).json({
      success: false,
      error: error instanceof Error ? error.message : 'DingTalk authentication failed',
    })
  }
})
