/**
 * Permissions Router
 * Handles permission management endpoints
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { authenticate } from '../middleware/auth'
import { Logger } from '../core/logger'
import { pool } from '../db/pg'
import { userHasPermission, listUserPermissions, isAdmin, invalidateUserPerms } from '../rbac/service'
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

      logger.info(`Permission '${permission}' granted to user ${userId} by admin ${adminUserId}`)
      res.json({
        success: true,
        userId,
        permission
      })
    } catch (error) {
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

      logger.info(`Permission '${permission}' revoked from user ${userId} by admin ${adminUserId}`)
      res.json({
        success: true,
        userId,
        permission
      })
    } catch (error) {
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
