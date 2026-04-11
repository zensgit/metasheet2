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

      // Trust the authenticated request user first. jwtAuthMiddleware refreshes
      // role/permission data on each request, and development fallback users only
      // exist on req.user (not in RBAC tables).
      // req.user is already hydrated by auth with the effective permission set.
      // Re-checking namespace admission here double-filters development users
      // and request-scoped permission snapshots that were already resolved.
      if (requestUserHasResolvedPermission(req.user, permissionCode)) {
        next()
        return
      }

      if (
        trustedTokenClaimsAllowPermission(req.user, permissionCode)
        && await isPermissionAllowedByNamespaceAdmission(userId, permissionCode)
      ) {
        next()
        return
      }

      // Check if user is admin (admins bypass permission checks)
      const adminCheck = await isAdmin(userId)
      if (adminCheck) {
        next()
        return
      }

      // Check specific permission
      const hasPermission = await userHasPermission(userId, permissionCode)
      if (hasPermission) {
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

/**
 * Check if user has any of the specified permissions
 */
export function rbacGuardAny(permissionCodes: string[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.id?.toString()

      if (!userId) {
        res.status(401).json({ error: 'Authentication required' })
        return
      }

      const requestUser = req.user
      if (requestUserIsAdmin(requestUser)) {
        next()
        return
      }
      for (const code of permissionCodes) {
        if (requestUserHasResolvedPermission(requestUser, code)) {
          next()
          return
        }
      }

      if (trustTokenClaims) {
        if (requestUserIsAdmin(requestUser)) {
          next()
          return
        }

        const tokenPerms = normalizeStringArray((requestUser as { perms?: unknown } | undefined)?.perms)
        for (const code of permissionCodes) {
          if (hasPermissionCode(tokenPerms, code) && await isPermissionAllowedByNamespaceAdmission(userId, code)) {
            next()
            return
          }
        }
      }

      // Check if user is admin
      const adminCheck = await isAdmin(userId)
      if (adminCheck) {
        next()
        return
      }

      // Check any of the permissions
      for (const code of permissionCodes) {
        const hasPermission = await userHasPermission(userId, code)
        if (hasPermission) {
          next()
          return
        }
      }

      logger.warn(`Access denied for user ${userId}: missing any of ${permissionCodes.join(', ')}`)
      res.status(403).json({ error: 'Insufficient permissions' })
    } catch (error) {
      logger.error('RBAC guard error', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Permission check failed' })
    }
  }
}

/**
 * Check if user has all specified permissions
 */
export function rbacGuardAll(permissionCodes: string[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.id?.toString()

      if (!userId) {
        res.status(401).json({ error: 'Authentication required' })
        return
      }

      const requestUser = req.user
      if (requestUserIsAdmin(requestUser)) {
        next()
        return
      }
      let requestUserHasAll = true
      for (const code of permissionCodes) {
        if (!requestUserHasResolvedPermission(requestUser, code)) {
          requestUserHasAll = false
          break
        }
      }
      if (requestUserHasAll) {
        next()
        return
      }

      if (trustTokenClaims) {
        if (requestUserIsAdmin(requestUser)) {
          next()
          return
        }

        const tokenPerms = normalizeStringArray((requestUser as { perms?: unknown } | undefined)?.perms)
        let tokenHasAll = true
        for (const code of permissionCodes) {
          if (!hasPermissionCode(tokenPerms, code) || !await isPermissionAllowedByNamespaceAdmission(userId, code)) {
            tokenHasAll = false
            break
          }
        }
        if (tokenHasAll) {
          next()
          return
        }
      }

      // Check if user is admin
      const adminCheck = await isAdmin(userId)
      if (adminCheck) {
        next()
        return
      }

      // Check all permissions
      const userPerms = await listUserPermissions(userId)
      const hasAll = permissionCodes.every(code => userPerms.includes(code))

      if (hasAll) {
        next()
        return
      }

      logger.warn(`Access denied for user ${userId}: missing some permissions`)
      res.status(403).json({ error: 'Insufficient permissions' })
    } catch (error) {
      logger.error('RBAC guard error', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Permission check failed' })
    }
  }
}

// Re-export service functions for convenience
export { userHasPermission, isAdmin, listUserPermissions, invalidateUserPerms, getPermCacheStatus } from './service'
