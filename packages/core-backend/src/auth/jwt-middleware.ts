import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { metrics } from '../metrics/metrics'

const AUTH_WHITELIST = [
  '/health',
  '/metrics',
  '/metrics/prom',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/refresh-token',
  '/api/plugins',
  '/api/v2/hello',
  '/api/v2/rpc-test',
  '/internal/metrics',
  '/api/cache-test',
  '/api/permissions/health'
]

export function isWhitelisted(path: string): boolean {
  return AUTH_WHITELIST.some(p => path.startsWith(p))
}

/**
 * Get JWT secret with proper security handling
 * In production: requires JWT_SECRET env var or generates secure temporary secret
 * In development: uses fallback secret with warning
 */
function getJwtSecret(): string {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET
  }

  if (process.env.NODE_ENV === 'production') {
    console.error('🔴 CRITICAL: JWT_SECRET missing in production!')
    // Generate a cryptographically secure random secret for this session
    return crypto.randomBytes(64).toString('hex')
  }

  console.warn('⚠️  JWT_SECRET not set! Using fallback (NOT FOR PRODUCTION)')
  return 'fallback-development-secret-change-in-production'
}

// Cache the secret to avoid regenerating for each request
let cachedSecret: string | null = null
function getSecret(): string {
  if (!cachedSecret) {
    cachedSecret = getJwtSecret()
  }
  return cachedSecret
}

export function jwtAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req.headers['authorization'] || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : undefined

    if (!token) {
      metrics.jwtAuthFail.inc({ reason: 'missing_token' })
      metrics.authFailures.inc()
      return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } })
    }

    const secret = getSecret()
    const payload = jwt.verify(token, secret)
    ;(req as any).user = payload
    return next()
  } catch (err: unknown) {
    const errorMessage = err instanceof jwt.TokenExpiredError ? 'expired_token' : 'invalid_token'
    metrics.jwtAuthFail.inc({ reason: errorMessage })
    metrics.authFailures.inc()
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } })
  }
}
