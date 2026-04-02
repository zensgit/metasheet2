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
import { markInviteAccepted } from '../auth/invite-ledger'
import { verifyInviteToken } from '../auth/invite-tokens'
import { validatePassword } from '../auth/password-policy'
import { createUserSession, getUserSession, listUserSessions, revokeUserSession, touchUserSession } from '../auth/session-registry'
import { revokeUserSessions } from '../auth/session-revocation'
import { FEATURE_FLAGS } from '../config/flags'
import { Logger } from '../core/logger'
import { query } from '../db/pg'
import { secretManager } from '../security/SecretManager'
import { getBcryptSaltRounds, resolveRuntimeJwtSecret } from '../security/auth-runtime-config'

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

type ProductMode = 'platform' | 'attendance' | 'plm-workbench'

function normalizeProductMode(value: unknown): ProductMode {
  if (value === 'attendance' || value === 'attendance-focused') return 'attendance'
  if (value === 'plm-workbench' || value === 'plmWorkbench' || value === 'plm-focused') return 'plm-workbench'
  return 'platform'
}

function buildFeaturePayload(authUser: User) {
  const permissions = Array.isArray(authUser.permissions) ? authUser.permissions : []
  const attendance = authUser.role === 'admin' || permissions.some((permission) => permission.startsWith('attendance:'))
  const attendanceAdmin = authUser.role === 'admin' || permissions.includes('attendance:admin')
  const attendanceImport = attendanceAdmin || permissions.includes('attendance:write')
  const workflow = FEATURE_FLAGS.workflowEnabled

  return {
    attendance,
    workflow,
    attendanceAdmin,
    attendanceImport,
    mode: normalizeProductMode(process.env.PRODUCT_MODE),
  }
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
