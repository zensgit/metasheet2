/**
 * RBAC Guard Middleware
 * Role-Based Access Control middleware for Express routes
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { userHasPermission, isAdmin, listUserPermissions } from './service'
import { Logger } from '../core/logger'
import { isPermissionAllowedByNamespaceAdmission } from './namespace-admission'

const logger = new Logger('RBACGuard')
const trustTokenClaims = process.env.RBAC_TOKEN_TRUST === 'true' || process.env.RBAC_TOKEN_TRUST === '1'

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
}

function hasPermissionCode(permissionCodes: string[], permissionCode: string): boolean {
  if (permissionCodes.includes(permissionCode) || permissionCodes.includes('*:*')) return true
  const resource = permissionCode.split(':')[0]
  return resource ? permissionCodes.includes(`${resource}:*`) : false
}

function requestUserIsAdmin(user: Express.Request['user']): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  const roles = normalizeStringArray(user.roles)
  return roles.includes('admin')
}

function requestUserHasResolvedPermission(user: Express.Request['user'], permissionCode: string): boolean {
  if (!user) return false
  if (requestUserIsAdmin(user)) return true
  return hasPermissionCode(normalizeStringArray(user.permissions), permissionCode)
}

function trustedTokenClaimsAllowPermission(user: Express.Request['user'], permissionCode: string): boolean {
  if (!trustTokenClaims || !user) return false
  if (normalizeStringArray(user.roles).includes('admin')) return true
  return hasPermissionCode(normalizeStringArray((user as { perms?: unknown }).perms), permissionCode)
}

/**
 * The decision `rbacGuard` makes for one permission code, without answering the request: `true` when
 * the request may use that code, `false` when it may not (including a request with no user id). An
 * error from a lookup is thrown to the caller. `rbacGuard` is built on this function, so a caller
 * that needs one answer per code gets exactly the guard's answer.
 */
export async function requestHasPermission(req: Request, permissionCode: string): Promise<boolean> {
  return evaluateRequestGuard(req, 'single', [permissionCode])
}

/**
 * RBAC guard middleware factory
 * Creates middleware that checks if user has required permission
 *
 * Can be called as:
 * - rbacGuard('permission_code') - single permission code
 * - rbacGuard('resource', 'action') - resource and action (converted to resource:action)
 */
export function rbacGuard(resourceOrPermission: string, action?: string): RequestHandler {
  // Build permission code from arguments
  const permissionCode = action ? `${resourceOrPermission}:${action}` : resourceOrPermission

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.id?.toString()

      if (!userId) {
        res.status(401).json({ error: 'Authentication required' })
        return
      }

      if (await requestHasPermission(req, permissionCode)) {
        next()
        return
      }

      logger.warn(`Access denied for user ${userId}: missing permission ${permissionCode}`)
      res.status(403).json({ error: 'Insufficient permissions' })
    } catch (error) {
      logger.error('RBAC guard error', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Permission check failed' })
    }
  }
}

/** Dependencies are injectable so callers can use a transaction-scoped reader. */
export interface GuardLookups {
  admission: typeof isPermissionAllowedByNamespaceAdmission
  isAdmin: typeof isAdmin
  hasPermission: typeof userHasPermission
  listPermissions: typeof listUserPermissions
}

const defaultLookups: GuardLookups = {
  admission: isPermissionAllowedByNamespaceAdmission,
  isAdmin,
  hasPermission: userHasPermission,
  listPermissions: listUserPermissions,
}

/** Preserve each guard's branch ordering and short circuits, including empty arrays. */
export async function evaluateRequestGuard(
  req: Request,
  mode: 'single' | 'any' | 'all',
  permissionCodes: readonly string[],
  lookups: GuardLookups = defaultLookups,
): Promise<boolean> {
  const userId = req.user?.id?.toString()
  if (!userId) return false
  const user = req.user
  if (requestUserIsAdmin(user)) return true

  if (mode === 'single') {
    const code = permissionCodes[0]
    if (requestUserHasResolvedPermission(user, code) && await lookups.admission(userId, code)) return true
    if (trustedTokenClaimsAllowPermission(user, code) && await lookups.admission(userId, code)) return true
    if (await lookups.isAdmin(userId)) return true
    return lookups.hasPermission(userId, code)
  }

  if (mode === 'any') {
    for (const code of permissionCodes) {
      if (requestUserHasResolvedPermission(user, code) && await lookups.admission(userId, code)) return true
    }
    if (trustTokenClaims) {
      if (requestUserIsAdmin(user)) return true
      const tokenPerms = normalizeStringArray((user as { perms?: unknown } | undefined)?.perms)
      for (const code of permissionCodes) {
        if (hasPermissionCode(tokenPerms, code) && await lookups.admission(userId, code)) return true
      }
    }
    if (await lookups.isAdmin(userId)) return true
    for (const code of permissionCodes) {
      if (await lookups.hasPermission(userId, code)) return true
    }
    return false
  }

  let resolvedHasAll = true
  for (const code of permissionCodes) {
    if (!requestUserHasResolvedPermission(user, code) || !await lookups.admission(userId, code)) {
      resolvedHasAll = false
      break
    }
  }
  if (resolvedHasAll) return true
  if (trustTokenClaims) {
    if (requestUserIsAdmin(user)) return true
    const tokenPerms = normalizeStringArray((user as { perms?: unknown } | undefined)?.perms)
    let tokenHasAll = true
    for (const code of permissionCodes) {
      if (!hasPermissionCode(tokenPerms, code) || !await lookups.admission(userId, code)) {
        tokenHasAll = false
        break
      }
    }
    if (tokenHasAll) return true
  }
  if (await lookups.isAdmin(userId)) return true
  const userPerms = await lookups.listPermissions(userId)
  return permissionCodes.every(code => userPerms.includes(code))
}

function compositeGuard(mode: 'any' | 'all', permissionCodes: string[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.id?.toString()
      if (!userId) {
        res.status(401).json({ error: 'Authentication required' })
        return
      }
      if (await evaluateRequestGuard(req, mode, permissionCodes)) {
        next()
        return
      }
      if (mode === 'any') logger.warn(`Access denied for user ${userId}: missing any of ${permissionCodes.join(', ')}`)
      else logger.warn(`Access denied for user ${userId}: missing some permissions`)
      res.status(403).json({ error: 'Insufficient permissions' })
    } catch (error) {
      logger.error('RBAC guard error', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Permission check failed' })
    }
  }
}

export function rbacGuardAny(permissionCodes: string[]): RequestHandler {
  return compositeGuard('any', permissionCodes)
}

export function rbacGuardAll(permissionCodes: string[]): RequestHandler {
  return compositeGuard('all', permissionCodes)
}

// Re-export service functions for convenience
export { userHasPermission, isAdmin, listUserPermissions, invalidateUserPerms, getPermCacheStatus } from './service'
