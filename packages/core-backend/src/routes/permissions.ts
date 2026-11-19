/**
 * Permissions Router
 * Handles permission management endpoints
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { authenticate } from '../middleware/auth'
import { Logger } from '../core/logger'
import { pool } from '../db/pg'
import { sendIfRecoveryConflict } from '../db/recovery-conflict'
import { AccessGraphUserUnavailableError } from '../directory/access-graph-mutex'
import { PlatformActorAuthorityLost } from '../admin/platform-actor-authority'
import { LegacyExceptionReasonInvalid, readLegacyExceptionReason, writeLegacyAuthorizationException } from '../admin/authorization-exception-compat'
import { AuthorizationExceptionWriteError } from '../admin/authorization-exception-write'
import { AuthorizationInputBusyError } from '../rbac/authorization-input-lock'
import { getPermissionTemplate, listPermissionTemplates } from '../auth/permission-templates'
import { userHasPermission, listUserPermissions, inspectUserPermissionGrants, isAdmin } from '../rbac/service'
import { isDatabaseSchemaError } from '../utils/database-errors'
import { businessCheck } from '../rbac/business-check'
import { readOnlyAuthorizationJwtAuth } from '../auth/jwt-middleware'

const logger = new Logger('PermissionsRouter')

// Graceful degradation for missing tables
let permsDegraded = false
const allowDegradation = process.env.RBAC_OPTIONAL === '1'

function sendExceptionWriteError(res: Response, error: unknown): boolean {
  if (error instanceof PlatformActorAuthorityLost) {
    res.status(403).json({ error: error.message, code: error.code })
  } else if (error instanceof AccessGraphUserUnavailableError) {
    res.status(error.code === 'NOT_FOUND' ? 404 : 409).json({ error: error.message, code: error.code })
  } else if (error instanceof LegacyExceptionReasonInvalid) {
    res.status(400).json({ error: 'Reason must contain 1 to 255 characters', code: 'INVALID_REASON' })
  } else if (error instanceof AuthorizationInputBusyError) {
    res.status(409).json({ error: error.message, code: error.code })
  } else if (error instanceof AuthorizationExceptionWriteError && (error.code === 'UNKNOWN_PERMISSION' || error.code === 'INVALID_INPUT')) {
    res.status(400).json({ error: 'Invalid permission grant', code: error.code })
  } else if ((error instanceof AuthorizationExceptionWriteError && error.code === 'STALE')
    || (error instanceof Error && error.message === 'AUTHORIZATION_EXCEPTION_STALE')) {
    res.status(409).json({ error: 'Permission sources changed, retry after reloading', code: 'STALE' })
  } else {
    return false
  }
  return true
}

interface Permission {
  code: string
  name: string
  description: string | null
  created_at: Date
}

export function permissionsRouter(): Router {
  const r = Router()

  // Get all permissions
  r.get('/api/permissions', authenticate, async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json({ error: 'Database not available' })
      }

      const result = await pool.query<Permission>(
        'SELECT * FROM permissions ORDER BY code'
      )

      res.json({
        data: result.rows,
        total: result.rowCount || 0
      })
    } catch (error) {
      if (isDatabaseSchemaError(error) && allowDegradation) {
        if (!permsDegraded) {
          logger.warn('Permissions service degraded - tables not found')
          permsDegraded = true
        }
        return res.json({ data: [], total: 0, degraded: true })
      }
      logger.error('Failed to get permissions', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to get permissions' })
    }
  })

  // Get permissions for current user
  r.get('/api/permissions/me', authenticate, async (req: Request, res: Response) => {
    try {
      const userId = String(req.user?.id || req.user?.sub || req.user?.userId || '')
      if (!userId) {
        return res.status(401).json({ error: 'User ID not found in token' })
      }

      const permissions = await listUserPermissions(userId)
      const admin = await isAdmin(userId)

      res.json({
        userId,
        permissions,
        isAdmin: admin
      })
    } catch (error) {
      if (isDatabaseSchemaError(error) && allowDegradation) {
        if (!permsDegraded) {
          logger.warn('Permissions service degraded - tables not found')
          permsDegraded = true
        }
        return res.json({ permissions: [], isAdmin: false, degraded: true })
      }
      logger.error('Failed to get user permissions', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to get user permissions' })
    }
  })

  // RBAC service preflight; this does not represent a business route guard.
  r.post('/api/permissions/check', authenticate, async (req: Request, res: Response) => {
    try {
      const { permission, userId: targetUserId } = req.body
      const requestingUserId = String(req.user?.id || req.user?.sub || req.user?.userId || '')

      if (!requestingUserId) {
        return res.status(401).json({ error: 'User ID not found in token' })
      }

      if (!permission) {
        return res.status(400).json({ error: 'permission is required' })
      }

      // Check if the requesting user is checking their own permission or is an admin
      const userToCheck = String(targetUserId || requestingUserId)
      const isRequestingAdmin = await isAdmin(requestingUserId)

      if (targetUserId && targetUserId !== requestingUserId && !isRequestingAdmin) {
        return res.status(403).json({ error: 'Cannot check permissions for another user' })
      }

      const hasPermission = await userHasPermission(userToCheck, permission)

      res.json({
        userId: userToCheck,
        permission,
        allowed: hasPermission
      })
    } catch (error) {
      if (isDatabaseSchemaError(error) && allowDegradation) {
        if (!permsDegraded) {
          logger.warn('Permissions service degraded - tables not found')
          permsDegraded = true
        }
        return res.json({ allowed: false, degraded: true })
      }
      logger.error('Failed to check permission', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to check permission' })
    }
  })

  // Business guard snapshot; resource and target adapters may report unknown.
  r.post('/api/permissions/v2/business-check', readOnlyAuthorizationJwtAuth, businessCheck)

  // Grant permission (admin only)
  r.post('/api/permissions/grant', authenticate, async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json({ error: 'Database not available' })
      }

      const { userId, permission, reason } = req.body ?? {}
      const adminUserId = String(req.user?.id || req.user?.sub || req.user?.userId || '').trim()

      if (!adminUserId) {
        return res.status(401).json({ error: 'User ID not found in token' })
      }

      if (typeof userId !== 'string' || !userId || typeof permission !== 'string' || !permission) {
        return res.status(400).json({ error: 'userId and permission are required' })
      }

      await writeLegacyAuthorizationException({
        actorId: adminUserId, userId, action: { kind: 'direct.grant', code: permission },
        reason: readLegacyExceptionReason(reason),
      })
      res.json({
        success: true,
        userId,
        permission
      })
    } catch (error) {
      if (sendIfRecoveryConflict(res, error) || sendExceptionWriteError(res, error)) return
      logger.error('Failed to grant permission', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to grant permission' })
    }
  })

  // Revoke permission (admin only)
  r.post('/api/permissions/revoke', authenticate, async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json({ error: 'Database not available' })
      }

      const { userId, permission, reason } = req.body ?? {}
      const adminUserId = String(req.user?.id || req.user?.sub || req.user?.userId || '').trim()

      if (!adminUserId) {
        return res.status(401).json({ error: 'User ID not found in token' })
      }

      if (typeof userId !== 'string' || !userId || typeof permission !== 'string' || !permission) {
        return res.status(400).json({ error: 'userId and permission are required' })
      }

      const result = await writeLegacyAuthorizationException({
        actorId: adminUserId, userId, action: { kind: 'direct.revoke', code: permission },
        reason: readLegacyExceptionReason(reason),
      })
      if (!result.changed) {
        return res.status(404).json({ error: 'Permission not found for user' })
      }

      res.json({
        success: true,
        userId,
        permission
      })
    } catch (error) {
      if (sendIfRecoveryConflict(res, error) || sendExceptionWriteError(res, error)) return
      logger.error('Failed to revoke permission', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to revoke permission' })
    }
  })

  // Clears matching users.permissions entries only. Direct grants, roles, is_admin,
  // and admissions stay. Authority is the locked actor's live user_roles admin
  // membership, not users.role, a token claim, or isAdmin(). The actor must be
  // active, activated, and not recycled. Inactive and pending targets remain
  // writable. Missing and recycled targets are refused. A no-match read does
  // not audit or invalidate.
  r.post('/api/permissions/legacy/revoke', authenticate, async (req: Request, res: Response) => {
    try {
      const adminUserId = String(req.user?.id || req.user?.sub || req.user?.userId || '').trim()
      if (!adminUserId) {
        return res.status(401).json({ error: 'User ID not found in token' })
      }
      if (!pool) {
        return res.status(503).json({ error: 'Database not available' })
      }
      if (typeof req.body?.userId !== 'string' || typeof req.body?.permission !== 'string') {
        return res.status(400).json({ error: 'userId and permission must be strings' })
      }
      const userId = req.body.userId.trim()
      const permission = req.body.permission.trim()
      if (!userId || !permission) {
        return res.status(400).json({ error: 'userId and permission are required' })
      }

      const result = await writeLegacyAuthorizationException({
        actorId: adminUserId, userId, action: { kind: 'legacy.revoke', code: permission },
        reason: readLegacyExceptionReason(req.body.reason),
      })
      if (!result.changed) {
        return res.status(404).json({ error: 'Legacy permission not found for user' })
      }

      res.json({
        success: true,
        userId,
        permission,
        changed: true,
      })
    } catch (error) {
      if (sendIfRecoveryConflict(res, error) || sendExceptionWriteError(res, error)) return
      logger.error('Failed to revoke legacy permission', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to revoke legacy permission' })
    }
  })

  // Get permissions for a specific user (admin only)
  r.get('/api/permissions/user/:userId', authenticate, async (req: Request, res: Response) => {
    try {
      const { userId } = req.params
      const adminUserId = String(req.user?.id || req.user?.sub || req.user?.userId || '')

      if (!adminUserId) {
        return res.status(401).json({ error: 'User ID not found in token' })
      }

      // Check if requesting user is admin or asking for their own permissions
      if (userId !== adminUserId) {
        const adminCheck = await isAdmin(adminUserId)
        if (!adminCheck) {
          return res.status(403).json({ error: 'Only admins can view other users\' permissions' })
        }
      }

      const [grants, admin] = await Promise.all([
        inspectUserPermissionGrants(userId),
        isAdmin(userId),
      ])

      if (grants.unavailable) {
        return res.json({
          userId,
          permissions: [],
          isAdmin: admin,
          degraded: true,
          unavailable: true,
          direct: [],
          inherited: [],
          inheritedRoles: [],
          legacy: [],
          effective: [],
          blockedByNamespaceAdmission: [],
        })
      }

      res.json({
        userId,
        permissions: grants.effective,
        isAdmin: admin,
        direct: grants.direct,
        inherited: grants.inherited,
        inheritedRoles: grants.inheritedRoles ?? [],
        legacy: grants.legacy,
        effective: grants.effective,
        blockedByNamespaceAdmission: grants.blockedByNamespaceAdmission,
      })
    } catch (error) {
      if (isDatabaseSchemaError(error) && allowDegradation) {
        if (!permsDegraded) {
          logger.warn('Permissions service degraded - tables not found')
          permsDegraded = true
        }
        return res.json({
          userId: req.params.userId,
          permissions: [],
          isAdmin: false,
          degraded: true,
          unavailable: true,
          direct: [],
          inherited: [],
          inheritedRoles: [],
          legacy: [],
          effective: [],
          blockedByNamespaceAdmission: [],
        })
      }
      logger.error('Failed to get user permissions', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to get user permissions' })
    }
  })

  r.get('/api/admin/permission-templates', authenticate, async (req: Request, res: Response) => {
    try {
      const adminUserId = String(req.user?.id || req.user?.sub || req.user?.userId || '')
      if (!adminUserId) {
        return res.status(401).json({ error: 'User ID not found in token' })
      }

      const adminCheck = await isAdmin(adminUserId)
      if (!adminCheck) {
        return res.status(403).json({ error: 'Only admins can view permission templates' })
      }

      const mode = typeof req.query.mode === 'string' ? req.query.mode.trim() : ''
      const templates = listPermissionTemplates(mode)
      res.json({
        data: templates,
        total: templates.length,
      })
    } catch (error) {
      logger.error('Failed to list permission templates', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to list permission templates' })
    }
  })

  r.post('/api/admin/permission-templates/apply', authenticate, async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json({ error: 'Database not available' })
      }

      const adminUserId = String(req.user?.id || req.user?.sub || req.user?.userId || '').trim()
      if (!adminUserId) {
        return res.status(401).json({ error: 'User ID not found in token' })
      }

      const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''
      const templateId = typeof req.body?.templateId === 'string' ? req.body.templateId.trim() : ''
      if (!userId || !templateId) {
        return res.status(400).json({ error: 'userId and templateId are required' })
      }

      const template = getPermissionTemplate(templateId)
      if (!template) {
        return res.status(404).json({ error: 'Permission template not found' })
      }

      const { profile } = await writeLegacyAuthorizationException({
        actorId: adminUserId,
        userId,
        action: { kind: 'template.apply', templateId: template.id, codes: template.permissions },
        reason: readLegacyExceptionReason(req.body.reason),
      })

      res.json({
        success: true,
        userId,
        template,
        permissions: profile?.permissions ?? [],
        isAdmin: profile?.isAdmin ?? false,
      })
    } catch (error) {
      if (sendIfRecoveryConflict(res, error) || sendExceptionWriteError(res, error)) return
      logger.error('Failed to apply permission template', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to apply permission template' })
    }
  })

  // Health check endpoint (whitelisted in auth)
  r.get('/api/permissions/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      degraded: permsDegraded,
      timestamp: new Date().toISOString()
    })
  })

  return r
}
