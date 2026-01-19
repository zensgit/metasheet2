import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { metrics } from '../metrics/metrics'
import { Logger } from '../core/logger'

const logger = new Logger('JWTMiddleware')

const AUTH_WHITELIST = [
  '/health',
  '/metrics',
  '/metrics/prom',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/refresh-token',
  '/api/auth/dev-token',
  '/api/plugins',
  '/api/v2/hello',
  '/api/v2/rpc-test',
  '/internal/metrics',
  '/api/cache-test',
  '/api/permissions/health'
]

// Use the global Express.Request type which already includes user property
// Exported for use by other modules that need authenticated request typing
export type AuthenticatedRequest = Request

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
    logger.error('CRITICAL: JWT_SECRET missing in production!')
    // Generate a cryptographically secure random secret for this session
    return crypto.randomBytes(64).toString('hex')
  }

  logger.warn('JWT_SECRET not set! Using fallback (NOT FOR PRODUCTION)')
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
    // JWT payload is an object with user information
    if (typeof payload === 'object' && payload !== null) {
      const normalized = payload as Record<string, unknown>
      if (normalized.id == null) {
        const fallbackId = normalized.userId ?? normalized.sub
        if (fallbackId != null) normalized.id = fallbackId
      }
      req.user = normalized as Express.Request['user']
    }
    return next()
  } catch (err: unknown) {
    const errorMessage = err instanceof jwt.TokenExpiredError ? 'expired_token' : 'invalid_token'
    metrics.jwtAuthFail.inc({ reason: errorMessage })
    metrics.authFailures.inc()
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } })
  }
}
