/**
 * API Token Authentication Middleware
 * Validates Bearer tokens with the `mst_` prefix and attaches scopes to the request.
 */

import type { Request, Response, NextFunction } from 'express'
import { ApiTokenService } from '../multitable/api-token-service'
import { db } from '../db/db'
import type { ApiTokenScope } from '../multitable/api-tokens'

// Extend Express Request with api token context
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiTokenScopes?: ApiTokenScope[]
      apiTokenUserId?: string
      /** The API token's own id (NOT the creator's). Used to key the per-token rate limiter. */
      apiTokenId?: string
      /** OAPI-4a per-base/sheet scope whitelists (undefined/empty = unscoped = creator-wide). */
      apiTokenBaseIds?: string[]
      apiTokenSheetIds?: string[]
      /** OAPI-4a: a scrubbed reason a 403-issuing guard sets so the write-audit boundary records it. */
      oapiAuditReason?: string
    }
  }
}

const TOKEN_PREFIX = 'mst_'
const apiTokenService = new ApiTokenService(db)

/**
 * Middleware that checks for `Authorization: Bearer mst_...` headers.
 *
 * - If the header is absent or does not start with `mst_`, the middleware
 *   passes through (allowing normal session auth to take over).
 * - If the header IS an API token, it is validated:
 *   - Invalid / revoked / expired tokens receive a 401.
 *   - Valid tokens have their scopes attached to `req.apiTokenScopes`.
 */
export async function apiTokenAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next()
    return
  }

  const token = authHeader.slice('Bearer '.length).trim()

  // Only intercept mst_ tokens; let JWT tokens pass through
  if (!token.startsWith(TOKEN_PREFIX)) {
    next()
    return
  }

  const result = await apiTokenService.validateToken(token)

  if ('reason' in result) {
    res.status(401).json({
      ok: false,
      error: { code: 'INVALID_API_TOKEN', message: result.reason },
    })
    return
  }

  // Attach scopes and synthetic user context
  req.apiTokenScopes = result.token.scopes
  req.apiTokenUserId = result.token.createdBy
  // The token's own id — keys the per-token rate limiter (OAPI-2a). NOT the creator id.
  req.apiTokenId = result.token.id
  // OAPI-4a per-base/sheet scope — read by `oapiScopeGuard` (undefined = unscoped = creator-wide).
  req.apiTokenBaseIds = result.token.baseIds
  req.apiTokenSheetIds = result.token.sheetIds

  // Set a minimal user object so downstream route guards work
  req.user = {
    id: result.token.createdBy,
    apiToken: true,
  } as Express.Request['user']

  next()
}

/**
 * Route-level guard that requires a specific scope on the API token.
 * If the request was not authenticated via API token, it passes through
 * (assuming normal session auth is in effect).
 */
export function requireScope(scope: ApiTokenScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Not an API-token request — let other auth handle it
    if (!req.apiTokenScopes) {
      next()
      return
    }

    if (!req.apiTokenScopes.includes(scope)) {
      // OAPI-4a: record the capability-scope denial reason for the write-audit boundary (distinct from
      // the base/sheet `out_of_base_sheet_scope` reason set by oapiScopeGuard).
      req.oapiAuditReason = 'insufficient_scope'
      res.status(403).json({
        ok: false,
        error: {
          code: 'INSUFFICIENT_SCOPE',
          message: `Required scope: ${scope}`,
        },
      })
      return
    }

    next()
  }
}
