/**
 * RBAC Guard Middleware
 * Role-Based Access Control middleware for Express routes
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { userHasPermission, isAdmin, listUserPermissions } from './service'
import { Logger } from '../core/logger'

const logger = new Logger('RBACGuard')
const trustTokenClaims = process.env.RBAC_TOKEN_TRUST === 'true' || process.env.RBAC_TOKEN_TRUST === '1'

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
      const tokenRoles = Array.isArray(req.user?.roles) ? req.user?.roles : []
      const tokenPerms = Array.isArray(req.user?.perms) ? req.user?.perms : []

      if (!userId) {
        res.status(401).json({ error: 'Authentication required' })
        return
      }

      if (trustTokenClaims) {
        // Fast-path for trusted JWT roles/permissions (useful for dev tokens)
        if (tokenRoles.includes('admin') || tokenPerms.includes(permissionCode)) {
          next()
          return
        }
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
      const tokenRoles = Array.isArray(req.user?.roles) ? req.user?.roles : []
      const tokenPerms = Array.isArray(req.user?.perms) ? req.user?.perms : []

      if (!userId) {
        res.status(401).json({ error: 'Authentication required' })
        return
      }

      if (trustTokenClaims) {
        if (tokenRoles.includes('admin')) {
          next()
          return
        }

        if (tokenPerms.length > 0) {
          const hasAny = permissionCodes.some((code) => tokenPerms.includes(code))
          if (hasAny) {
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
      const tokenRoles = Array.isArray(req.user?.roles) ? req.user?.roles : []
      const tokenPerms = Array.isArray(req.user?.perms) ? req.user?.perms : []

      if (!userId) {
        res.status(401).json({ error: 'Authentication required' })
        return
      }

      if (trustTokenClaims) {
        if (tokenRoles.includes('admin')) {
          next()
          return
        }

        if (tokenPerms.length > 0) {
          const hasAll = permissionCodes.every((code) => tokenPerms.includes(code))
          if (hasAll) {
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
