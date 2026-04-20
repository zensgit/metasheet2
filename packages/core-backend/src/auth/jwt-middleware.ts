import type { Request, Response, NextFunction } from 'express'
import { extractTenantFromHeaders } from '../db/sharding/tenant-context'
import { metrics } from '../metrics/metrics'
import { authService } from './AuthService'

const AUTH_WHITELIST = [
  '/health',
  '/api/health',
  '/metrics',
  '/metrics/prom',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/invite/preview',
  '/api/auth/invite/accept',
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

const PASSWORD_CHANGE_WHITELIST = [
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/password/change',
  '/api/auth/refresh',
  '/api/auth/refresh-token',
] as const

// Use the global Express.Request type which already includes user property
// Exported for use by other modules that need authenticated request typing
export type AuthenticatedRequest = Request

export function isWhitelisted(path: string): boolean {
  return AUTH_WHITELIST.some(p => path.startsWith(p))
}

const PUBLIC_FORM_CONTEXT_PATH = '/api/multitable/form-context'
const PUBLIC_FORM_SUBMIT_PATH = /^\/api\/multitable\/views\/[^/]+\/submit$/

type PublicFormBypassRequest = Pick<Request, 'path' | 'method' | 'query' | 'body'>

function extractPublicToken(req: PublicFormBypassRequest): string {
  const queryToken = typeof req.query?.publicToken === 'string' ? req.query.publicToken.trim() : ''
  if (queryToken) return queryToken
  return typeof req.body?.publicToken === 'string' ? req.body.publicToken.trim() : ''
}

export function isPublicFormAuthBypass(req: PublicFormBypassRequest): boolean {
  const method = (req.method || '').toUpperCase()
  const path = req.path || ''
  const publicToken = extractPublicToken(req)

  if (!publicToken) return false
  if (method === 'GET' && path === PUBLIC_FORM_CONTEXT_PATH) return true
  if (method === 'POST' && PUBLIC_FORM_SUBMIT_PATH.test(path)) return true
  return false
}

function isPasswordChangeWhitelisted(path: string): boolean {
  return PASSWORD_CHANGE_WHITELIST.some((prefix) => path.startsWith(prefix))
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

    if (user.must_change_password === true && !isPasswordChangeWhitelisted(req.path || req.originalUrl || '')) {
      return res.status(403).json({
        ok: false,
        error: {
          code: 'PASSWORD_CHANGE_REQUIRED',
          message: 'Password change required',
        },
      })
    }

    const headerTenantId = extractTenantFromHeaders(req.headers as Record<string, unknown> | undefined)
    if (!user.tenantId && headerTenantId) {
      user.tenantId = headerTenantId
    }

    req.user = user as Express.Request['user']
    return next()
  } catch (err: unknown) {
    const errorMessage = err instanceof Error && err.name === 'TokenExpiredError' ? 'expired_token' : 'invalid_token'
    metrics.jwtAuthFail.inc({ reason: errorMessage })
    metrics.authFailures.inc()
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } })
  }
}
