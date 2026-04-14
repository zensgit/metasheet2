/**
 * API Token Authentication Middleware
 * Validates Bearer tokens with the `mst_` prefix and attaches scopes to the request.
 */

import type { Request, Response, NextFunction } from 'express'
import { apiTokenService } from '../multitable/api-token-service'
import type { ApiTokenScope } from '../multitable/api-tokens'

// Extend Express Request with api token context
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiTokenScopes?: ApiTokenScope[]
      apiTokenUserId?: string
    }
  }
}

const TOKEN_PREFIX = 'mst_'

/**
 * Middleware that checks for `Authorization: Bearer mst_...` headers.
 *
 * - If the header is absent or does not start with `mst_`, the middleware
 *   passes through (allowing normal session auth to take over).
 * - If the header IS an API token, it is validated:
 *   - Invalid / revoked / expired tokens receive a 401.
 *   - Valid tokens have their scopes attached to `req.apiTokenScopes`.
 */
export function apiTokenAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
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

  const result = apiTokenService.validateToken(token)

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
