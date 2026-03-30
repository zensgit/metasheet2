import type { NextFunction, Request, Response } from 'express'
import { metrics } from '../metrics/metrics'
import { authService } from './AuthService'

const AUTH_WHITELIST = [
  '/health',
  '/metrics',
  '/metrics/prom',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/refresh-token',
  '/api/auth/dev-token',
  '/api/auth/dingtalk/launch',
  '/api/auth/dingtalk/callback',
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

export async function jwtAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req.headers['authorization'] || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : undefined

    if (!token) {
      metrics.jwtAuthFail.inc({ reason: 'missing_token' })
      metrics.authFailures.inc()
      return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } })
    }

    const user = await authService.verifyToken(token)
    if (!user) {
      metrics.jwtAuthFail.inc({ reason: 'invalid_token' })
      metrics.authFailures.inc()
      return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } })
    }

    req.user = user as Express.Request['user']
    return next()
  } catch (err: unknown) {
    const errorMessage = 'invalid_token'
    metrics.jwtAuthFail.inc({ reason: errorMessage })
    metrics.authFailures.inc()
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } })
  }
}
