import type { Request, Response, NextFunction } from 'express'
import { extractTenantFromHeaders } from '../db/sharding/tenant-context'
import { metrics } from '../metrics/metrics'
import { authService } from './AuthService'

const AUTH_WHITELIST = [
  '/health',
  '/api/health',
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

function resolveBearerToken(req: Request): string | undefined {
  const auth = req.headers['authorization'] || ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : undefined
}

async function hydrateAuthenticatedUser(req: Request, token: string): Promise<
  | { ok: true }
  | { ok: false; statusCode: number; body: { ok: false; error: { code: string; message: string } }; metricReason?: string }
> {
  try {
    const user = await authService.verifyToken(token)
    if (!user) {
      return {
        ok: false,
        statusCode: 401,
        body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } },
        metricReason: 'invalid_token',
      }
    }

    // DingTalk-protected public forms use optional auth. A local temporary
    // password requirement should not block this external-auth form flow.
    if (
      user.must_change_password === true &&
      !isPasswordChangeWhitelisted(req.path || req.originalUrl || '') &&
      !isPublicFormAuthBypass(req)
    ) {
      return {
        ok: false,
        statusCode: 403,
        body: {
          ok: false,
          error: {
            code: 'PASSWORD_CHANGE_REQUIRED',
            message: 'Password change required',
          },
        },
      }
    }

    const headerTenantId = extractTenantFromHeaders(req.headers as Record<string, unknown> | undefined)
    if (!user.tenantId && headerTenantId) {
      user.tenantId = headerTenantId
    }

    req.user = user as Express.Request['user']
    return { ok: true }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error && err.name === 'TokenExpiredError' ? 'expired_token' : 'invalid_token'
    return {
      ok: false,
      statusCode: 401,
      body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } },
      metricReason: errorMessage,
    }
  }
}

type HydratedAuthResult = Awaited<ReturnType<typeof hydrateAuthenticatedUser>>

function isHydrateFailure(result: HydratedAuthResult): result is Extract<HydratedAuthResult, { ok: false }> {
  return result.ok === false
}

export async function optionalJwtAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = resolveBearerToken(req)
  if (!token) return next()

  const result = await hydrateAuthenticatedUser(req, token)
  if (isHydrateFailure(result)) {
    if (result.metricReason) {
      metrics.jwtAuthFail.inc({ reason: result.metricReason })
      metrics.authFailures.inc()
    }
    return res.status(result.statusCode).json(result.body)
  }
  return next()
}

export async function jwtAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = resolveBearerToken(req)

  if (!token) {
    metrics.jwtAuthFail.inc({ reason: 'missing_token' })
    metrics.authFailures.inc()
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } })
  }

  const result = await hydrateAuthenticatedUser(req, token)
  if (isHydrateFailure(result)) {
    if (result.metricReason) {
      metrics.jwtAuthFail.inc({ reason: result.metricReason })
      metrics.authFailures.inc()
    }
    return res.status(result.statusCode).json(result.body)
  }
  return next()
}
