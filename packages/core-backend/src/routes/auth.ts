/**
 * 认证路由
 * 提供登录、注册、token刷新等认证服务
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express'
import jwt, { type SignOptions } from 'jsonwebtoken'
import { authService, type User } from '../auth/AuthService'
import { FEATURE_FLAGS } from '../config/flags'
import { Logger } from '../core/logger'

const logger = new Logger('AuthRouter')

export const authRouter = Router()

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
        token: result.token
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
    type ProductMode = 'platform' | 'attendance'
    const normalizeProductMode = (value: unknown): ProductMode => {
      if (value === 'attendance' || value === 'attendance-focused') return 'attendance'
      return 'platform'
    }

    const permissions = Array.isArray(authUser.permissions) ? authUser.permissions : []
    const attendance = authUser.role === 'admin' || permissions.some((permission) => permission.startsWith('attendance:'))
    const attendanceAdmin = authUser.role === 'admin' || permissions.includes('attendance:admin')
    const attendanceImport = attendanceAdmin || permissions.includes('attendance:write')
    const workflow = FEATURE_FLAGS.workflowEnabled

    res.json({
      success: true,
      data: {
        user: authUser,
        features: {
          attendance,
          workflow,
          attendanceAdmin,
          attendanceImport,
          mode: normalizeProductMode(process.env.PRODUCT_MODE),
        },
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
