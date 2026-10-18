import type { Request, Response, NextFunction } from 'express'
import { extractTenantFromHeaders } from '../db/sharding/tenant-context'
import { metrics } from '../metrics/metrics'
import { apiPathEquals, isGateException } from './api-path-policy'
import { authService } from './AuthService'
import { takeVerifiedTenantClaim } from './verified-tenant-claim'
import { verifyManagedCompanionToken } from './plm-managed-session'
import { managedRequestContext } from '../services/plm-managed-request-context'
import {
  isManagedCompanionPurpose,
  MANAGED_SESSION_COOKIE,
  readRequestCookie,
} from '../services/plm-managed-companion'

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

/**
 * True when `path` is a declared exception to the global session gate.
 *
 * The exception list itself lives in `api-path-policy.ts` (`GLOBAL_GATE_EXCEPTIONS`), declared once
 * with each entry's kind (`exact` vs `prefix`), so the gate and every other layer that asks about API
 * paths consult the same table. This wrapper stays for the call sites that already import it.
 */
export function isWhitelisted(path: string): boolean {
  return isGateException(path)
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

function isPasswordChangeWhitelisted(pathOrUrl: string): boolean {
  // The caller falls back to `req.originalUrl`, which — unlike `req.path` — still carries the query
  // string. Compare the path portion only, so both callers' inputs mean the same thing here.
  const path = (pathOrUrl || '').split('?')[0]
  // Exact, via the shared policy: each entry names one route, so a longer path that merely starts with
  // one of them is not covered by it.
  return PASSWORD_CHANGE_WHITELIST.some((entry) => apiPathEquals(path, entry))
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

    const verifiedTenantClaim = takeVerifiedTenantClaim(user)
    if (verifiedTenantClaim) {
      req.verifiedTenantClaim = verifiedTenantClaim
    }

    const authenticatedTenantId = typeof user.tenantId === 'string' ? user.tenantId.trim() : ''
    if (authenticatedTenantId) {
      req.authenticatedTenantId = authenticatedTenantId
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
    if (isPublicFormAuthBypass(req)) {
      // Public-form auth is optional. A stale local browser token should not
      // block anonymous or DingTalk re-authenticated form access.
      return next()
    }
    if (result.metricReason) {
      metrics.jwtAuthFail.inc({ reason: result.metricReason })
      metrics.authFailures.inc()
    }
    return res.status(result.statusCode).json(result.body)
  }
  return next()
}

function managedSessionIdOf(user: Express.Request['user']): string | null {
  const value = (user as { managedSessionId?: unknown } | undefined)?.managedSessionId
  return typeof value === 'string' && value.length > 0 ? value : null
}

function continueWithManagedContext(
  req: Request,
  next: NextFunction,
  input: { userId: string | null; sessionId: string | null; conflict: boolean },
): void {
  managedRequestContext.run(input, () => {
    next()
  })
}

export async function jwtAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = resolveBearerToken(req)
  const managedCookie = readRequestCookie(req.headers.cookie, MANAGED_SESSION_COOKIE)

  if (!token) {
    if (managedCookie) {
      const managed = await verifyManagedCompanionToken(managedCookie)
      if (managed) {
        if (
          managed.must_change_password === true
          && !isPasswordChangeWhitelisted(req.path || req.originalUrl || '')
          && !isPublicFormAuthBypass(req)
        ) {
          return res.status(403).json({
            ok: false,
            error: { code: 'PASSWORD_CHANGE_REQUIRED', message: 'Password change required' },
          })
        }
        const verifiedTenantClaim = takeVerifiedTenantClaim(managed)
        if (verifiedTenantClaim) req.verifiedTenantClaim = verifiedTenantClaim
        if (typeof managed.tenantId === 'string' && managed.tenantId.trim()) {
          req.authenticatedTenantId = managed.tenantId.trim()
        }
        req.user = managed as Express.Request['user']
        return continueWithManagedContext(req, next, {
          userId: managed.id,
          sessionId: managedSessionIdOf(managed),
          conflict: false,
        })
      }
    }
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
  const user = req.user
  let sessionId: string | null = null
  let conflict = false
  if (user && isManagedCompanionPurpose((user as { managedPurpose?: unknown }).managedPurpose)) {
    sessionId = managedSessionIdOf(user)
  } else if (managedCookie) {
    const managed = await verifyManagedCompanionToken(managedCookie)
    const bearerTenant = typeof user?.tenantId === 'string' ? user.tenantId.trim() : ''
    const managedTenant = typeof managed?.tenantId === 'string' ? managed.tenantId.trim() : ''
    const tenantConflict = bearerTenant.length > 0 && managedTenant.length > 0 && bearerTenant !== managedTenant
    if (managed && user && (managed.id !== user.id || tenantConflict)) conflict = true
    else if (managed) sessionId = managedSessionIdOf(managed)
  }
  return continueWithManagedContext(req, next, {
    userId: typeof user?.id === 'string' ? user.id : null,
    sessionId: conflict ? null : sessionId,
    conflict,
  })
}
