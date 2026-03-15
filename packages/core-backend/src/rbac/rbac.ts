/**
 * RBAC Guard Middleware
 * Role-Based Access Control middleware for Express routes
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { userHasPermission, isAdmin, listUserPermissions } from './service'
import { Logger } from '../core/logger'

const logger = new Logger('RBACGuard')

function getClaimRoles(user: Request['user']): string[] {
  const roles = new Set<string>()
  if (typeof user?.role === 'string' && user.role.trim().length > 0) {
    roles.add(user.role.trim())
  }
  if (Array.isArray(user?.roles)) {
    for (const role of user.roles) {
      if (typeof role === 'string' && role.trim().length > 0) {
        roles.add(role.trim())
      }
    }
  }
  return [...roles]
}

function getClaimPermissions(user: Request['user']): string[] {
  const permissions = new Set<string>()
  if (Array.isArray(user?.perms)) {
    for (const permission of user.perms) {
      if (typeof permission === 'string' && permission.trim().length > 0) {
        permissions.add(permission.trim())
      }
    }
  }
  if (Array.isArray(user?.permissions)) {
    for (const permission of user.permissions) {
      if (typeof permission === 'string' && permission.trim().length > 0) {
        permissions.add(permission.trim())
      }
    }
  }
  return [...permissions]
}

function hasClaimPermission(user: Request['user'], permissionCode: string): boolean {
  const roles = getClaimRoles(user)
  if (roles.includes('admin')) {
    return true
  }

  const permissions = getClaimPermissions(user)
  if (permissions.includes('*:*') || permissions.includes('admin:all') || permissions.includes(permissionCode)) {
    return true
  }

  const [resource] = permissionCode.split(':')
  return Boolean(resource) && permissions.includes(`${resource}:*`)
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

      if (hasClaimPermission(req.user, permissionCode)) {
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

      if (permissionCodes.some((code) => hasClaimPermission(req.user, code))) {
        next()
        return
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

      if (permissionCodes.every((code) => hasClaimPermission(req.user, code))) {
        next()
        return
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
