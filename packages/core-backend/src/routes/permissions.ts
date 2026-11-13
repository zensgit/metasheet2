/**
 * Permissions Router
 * Handles permission management endpoints
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { authenticate } from '../middleware/auth'
import { Logger } from '../core/logger'
import { pool, transaction } from '../db/pg'
import { sendIfRecoveryConflict } from '../db/recovery-conflict'
import { auditLog } from '../audit/audit'
import { AccessGraphUserUnavailableError } from '../directory/access-graph-mutex'
import { PlatformActorAuthorityLost } from '../admin/platform-actor-authority'
import { revokeLegacyUserPermission } from '../admin/legacy-permission-revoke'
import { getPermissionTemplate, listPermissionTemplates } from '../auth/permission-templates'
import { userHasPermission, listUserPermissions, inspectUserPermissionGrants, isAdmin, invalidateUserPerms } from '../rbac/service'
import { isDatabaseSchemaError } from '../utils/database-errors'

const logger = new Logger('PermissionsRouter')

// Graceful degradation for missing tables
let permsDegraded = false
const allowDegradation = process.env.RBAC_OPTIONAL === '1'

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

  // Check permission
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

  // Grant permission (admin only)
  r.post('/api/permissions/grant', authenticate, async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json({ error: 'Database not available' })
      }

      const { userId, permission } = req.body
      const adminUserId = String(req.user?.id || req.user?.sub || req.user?.userId || '')

      if (!adminUserId) {
        return res.status(401).json({ error: 'User ID not found in token' })
      }

      if (!userId || !permission) {
        return res.status(400).json({ error: 'userId and permission are required' })
      }

      // Check if requesting user is admin
      const adminCheck = await isAdmin(adminUserId)
      if (!adminCheck) {
        return res.status(403).json({ error: 'Only admins can grant permissions' })
      }

      // Check if permission code exists
      const permExists = await pool.query<{ code: string }>(
        'SELECT code FROM permissions WHERE code = $1',
        [permission]
      )

      if (permExists.rows.length === 0) {
        return res.status(400).json({ error: `Permission code '${permission}' does not exist` })
      }

      // Grant permission (upsert to avoid duplicates)
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code)
         VALUES ($1, $2)
         ON CONFLICT (user_id, permission_code) DO NOTHING`,
        [userId, permission]
      )

      // Invalidate cache for the user
      invalidateUserPerms(userId)

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'grant',
        resourceType: 'permission',
        resourceId: `${userId}:${permission}`,
        meta: {
          adminUserId,
          userId,
          permission,
        },
      })

      logger.info(`Permission '${permission}' granted to user ${userId} by admin ${adminUserId}`)
      res.json({
        success: true,
        userId,
        permission
      })
    } catch (error) {
      // O2-S2: user_permissions is a recovery-authority table — a marker 40001 under a
      // held recovery lease is a retryable 409, not an unclassified 500. Additive only:
      // every other error keeps the exact path below.
      if (sendIfRecoveryConflict(res, error)) return
      if (isDatabaseSchemaError(error) && allowDegradation) {
        if (!permsDegraded) {
          logger.warn('Permissions service degraded - tables not found')
          permsDegraded = true
        }
        return res.json({ success: true, degraded: true })
      }
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

      const { userId, permission } = req.body
      const adminUserId = String(req.user?.id || req.user?.sub || req.user?.userId || '')

      if (!adminUserId) {
        return res.status(401).json({ error: 'User ID not found in token' })
      }

      if (!userId || !permission) {
        return res.status(400).json({ error: 'userId and permission are required' })
      }

      // Check if requesting user is admin
      const adminCheck = await isAdmin(adminUserId)
      if (!adminCheck) {
        return res.status(403).json({ error: 'Only admins can revoke permissions' })
      }

      // Revoke permission
      const result = await pool.query(
        'DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = $2',
        [userId, permission]
      )

      // Invalidate cache for the user
      invalidateUserPerms(userId)

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Permission not found for user' })
      }

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'revoke',
        resourceType: 'permission',
        resourceId: `${userId}:${permission}`,
        meta: {
          adminUserId,
          userId,
          permission,
        },
      })

      logger.info(`Permission '${permission}' revoked from user ${userId} by admin ${adminUserId}`)
      res.json({
        success: true,
        userId,
        permission
      })
    } catch (error) {
      // O2-S2: see the grant handler — marker 40001 → retryable 409, all else unchanged.
      if (sendIfRecoveryConflict(res, error)) return
      if (isDatabaseSchemaError(error) && allowDegradation) {
        if (!permsDegraded) {
          logger.warn('Permissions service degraded - tables not found')
          permsDegraded = true
        }
        return res.json({ success: true, degraded: true })
      }
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

      const result = await transaction(async (client) => revokeLegacyUserPermission(client, {
        actorId: adminUserId,
        userId,
        permission,
      }))
      if (!result.changed) {
        return res.status(404).json({ error: 'Legacy permission not found for user' })
      }

      // Local generation bump for a read already in this process. The next
      // listUserPermissions call in every process reads the committed row.
      invalidateUserPerms(userId)
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'revoke',
        resourceType: 'legacy-permission',
        resourceId: `${userId}:${permission}`,
        meta: {
          adminUserId,
          userId,
          permission,
        },
      })

      res.json({
        success: true,
        userId,
        permission,
        changed: true,
      })
    } catch (error) {
      if (sendIfRecoveryConflict(res, error)) return
      if (error instanceof AccessGraphUserUnavailableError) {
        if (error.code === 'NOT_FOUND') return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' })
        return res.status(409).json({ error: error.message, code: 'USER_IN_RECYCLE_BIN' })
      }
      if (error instanceof PlatformActorAuthorityLost) {
        return res.status(403).json({ error: error.message, code: error.code })
      }
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

      const adminUserId = String(req.user?.id || req.user?.sub || req.user?.userId || '')
      if (!adminUserId) {
        return res.status(401).json({ error: 'User ID not found in token' })
      }

      const adminCheck = await isAdmin(adminUserId)
      if (!adminCheck) {
        return res.status(403).json({ error: 'Only admins can apply permission templates' })
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

      if (template.permissions.length > 0) {
        const values = template.permissions.map((_, index) => `($1, $${index + 2})`).join(', ')
        await pool.query(
          `INSERT INTO user_permissions (user_id, permission_code)
           VALUES ${values}
           ON CONFLICT (user_id, permission_code) DO NOTHING`,
          [userId, ...template.permissions],
        )
      }

      invalidateUserPerms(userId)

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'grant',
        resourceType: 'permission-template',
        resourceId: `${userId}:${template.id}`,
        meta: {
          adminUserId,
          userId,
          templateId: template.id,
          productMode: template.productMode,
          permissions: template.permissions,
        },
      })

      const permissions = await listUserPermissions(userId)
      const admin = await isAdmin(userId)

      res.json({
        success: true,
        userId,
        template,
        permissions,
        isAdmin: admin,
      })
    } catch (error) {
      // O2-S2: see the grant handler — marker 40001 → retryable 409, all else unchanged.
      if (sendIfRecoveryConflict(res, error)) return
      if (isDatabaseSchemaError(error) && allowDegradation) {
        if (!permsDegraded) {
          logger.warn('Permissions template service degraded - tables not found')
          permsDegraded = true
        }
        return res.json({ success: true, degraded: true })
      }
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
