/**
 * Snapshot API Routes
 * Phase 9: Snapshot / Versioning MVP
 */

import type { Request, Response } from 'express';
import { Router } from 'express'
import { rbacGuard } from '../rbac/rbac'
import { snapshotService } from '../services/SnapshotService'
import { Logger } from '../core/logger'

const logger = new Logger('SnapshotsRouter')

type ProtectionLevel = 'normal' | 'protected' | 'critical'
type ReleaseChannel = 'stable' | 'canary' | 'beta' | 'experimental'

const getUserId = (req: Request) =>
  req.user?.id?.toString() || (req.headers['x-user-id'] as string) || 'system'

export function snapshotsRouter(): Router {
  const r = Router()

  // List snapshots for a view or filtered query
  r.get('/api/snapshots', rbacGuard('permissions', 'read'), async (req: Request, res: Response) => {
    try {
      const tags = req.query.tags
      const protectionLevel = req.query.protection_level
      const releaseChannel = req.query.release_channel

      if (tags || protectionLevel || releaseChannel) {
        let snapshots: unknown[] = []
        if (tags) {
          const tagArray = String(tags).split(',').map(t => t.trim()).filter(Boolean)
          snapshots = await snapshotService.getByTags(tagArray)
        } else if (protectionLevel) {
          if (!['normal', 'protected', 'critical'].includes(String(protectionLevel))) {
            return res.status(400).json({
              ok: false,
              success: false,
              error: { code: 'BAD_REQUEST', message: 'Invalid protection level' }
            })
          }
          snapshots = await snapshotService.getByProtectionLevel(protectionLevel as ProtectionLevel)
        } else if (releaseChannel) {
          if (!['stable', 'canary', 'beta', 'experimental'].includes(String(releaseChannel))) {
            return res.status(400).json({
              ok: false,
              success: false,
              error: { code: 'BAD_REQUEST', message: 'Invalid release channel' }
            })
          }
          snapshots = await snapshotService.getByReleaseChannel(releaseChannel as ReleaseChannel)
        }

        return res.json({
          ok: true,
          success: true,
          data: snapshots,
          snapshots,
          count: snapshots.length
        })
      }

      const viewId = String(req.query.view_id || '')
      if (!viewId) {
        return res.status(400).json({
          ok: false,
          error: { code: 'BAD_REQUEST', message: 'view_id is required' }
        })
      }

      const snapshots = await snapshotService.listSnapshots(viewId)
      return res.json({ ok: true, success: true, data: snapshots, snapshots })
    } catch (e) {
      const err = e as Error
      return res.status(500).json({
        ok: false,
        error: { code: 'SNAPSHOT_LIST_ERROR', message: err.message }
      })
    }
  })

  // Add/remove snapshot tags
  r.put('/api/snapshots/:id/tags', rbacGuard('permissions', 'write'), async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const { add, remove } = req.body
      const userId = getUserId(req)

      if (add && Array.isArray(add) && add.length > 0) {
        await snapshotService.addTags(id, add, userId)
      }

      if (remove && Array.isArray(remove) && remove.length > 0) {
        await snapshotService.removeTags(id, remove, userId)
      }

      const snapshot = await snapshotService.getSnapshot(id)
      return res.json({
        ok: true,
        success: true,
        snapshot,
        message: 'Tags updated successfully'
      })
    } catch (error) {
      logger.error('Failed to update tags', error as Error)
      return res.status(500).json({
        ok: false,
        success: false,
        error: (error as Error).message
      })
    }
  })

  // Set protection level
  r.patch('/api/snapshots/:id/protection', rbacGuard('permissions', 'write'), async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const { level } = req.body
      const userId = getUserId(req)

      if (!level || !['normal', 'protected', 'critical'].includes(level)) {
        return res.status(400).json({
          ok: false,
          success: false,
          error: 'Invalid protection level. Must be: normal, protected, or critical'
        })
      }

      await snapshotService.setProtectionLevel(id, level, userId)

      const snapshot = await snapshotService.getSnapshot(id)
      return res.json({
        ok: true,
        success: true,
        snapshot,
        message: `Protection level set to: ${level}`
      })
    } catch (error) {
      logger.error('Failed to set protection level', error as Error)
      return res.status(500).json({
        ok: false,
        success: false,
        error: (error as Error).message
      })
    }
  })

  // Set release channel
  r.patch('/api/snapshots/:id/release-channel', rbacGuard('permissions', 'write'), async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const { channel } = req.body
      const userId = getUserId(req)

      if (channel && !['stable', 'canary', 'beta', 'experimental'].includes(channel)) {
        return res.status(400).json({
          ok: false,
          success: false,
          error: 'Invalid release channel. Must be: stable, canary, beta, or experimental'
        })
      }

      await snapshotService.setReleaseChannel(id, channel, userId)

      const snapshot = await snapshotService.getSnapshot(id)
      return res.json({
        ok: true,
        success: true,
        snapshot,
        message: `Release channel set to: ${channel || 'none'}`
      })
    } catch (error) {
      logger.error('Failed to set release channel', error as Error)
      return res.status(500).json({
        ok: false,
        success: false,
        error: (error as Error).message
      })
    }
  })

  // Get a specific snapshot
  r.get('/api/snapshots/:id', rbacGuard('permissions', 'read'), async (req: Request, res: Response) => {
    const snapshotId = req.params.id

    try {
      const snapshot = await snapshotService.getSnapshot(snapshotId)
      if (!snapshot) {
        return res.status(404).json({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Snapshot not found' }
        })
      }
      return res.json({ ok: true, data: snapshot })
    } catch (e) {
      const err = e as Error
      return res.status(500).json({
        ok: false,
        error: { code: 'SNAPSHOT_GET_ERROR', message: err.message }
      })
    }
  })

  // Create a new snapshot
  r.post('/api/snapshots', rbacGuard('permissions', 'write'), async (req: Request, res: Response) => {
    const userId = getUserId(req)
    const { view_id, name, description, snapshot_type, metadata, expires_at } = req.body

    if (!view_id || !name) {
      return res.status(400).json({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'view_id and name are required' }
      })
    }

    try {
      const snapshot = await snapshotService.createSnapshot({
        viewId: view_id,
        name,
        description,
        createdBy: userId,
        snapshotType: snapshot_type,
        metadata,
        expiresAt: expires_at ? new Date(expires_at) : undefined
      })

      return res.status(201).json({ ok: true, data: snapshot })
    } catch (e) {
      const err = e as Error
      return res.status(500).json({
        ok: false,
        error: { code: 'SNAPSHOT_CREATE_ERROR', message: err.message }
      })
    }
  })

  // Restore a snapshot
  r.post('/api/snapshots/:id/restore', rbacGuard('permissions', 'write'), async (req: Request, res: Response) => {
    const snapshotId = req.params.id
    const userId = getUserId(req)
    const { restore_type, item_types } = req.body

    try {
      const result = await snapshotService.restoreSnapshot({
        snapshotId,
        restoredBy: userId,
        restoreType: restore_type,
        itemTypes: item_types
      })

      return res.json({ ok: true, data: result })
    } catch (e) {
      const err = e as Error
      return res.status(500).json({
        ok: false,
        error: { code: 'SNAPSHOT_RESTORE_ERROR', message: err.message }
      })
    }
  })

  // Delete a snapshot
  r.delete('/api/snapshots/:id', rbacGuard('permissions', 'write'), async (req: Request, res: Response) => {
    const snapshotId = req.params.id
    const userId = getUserId(req)

    try {
      await snapshotService.deleteSnapshot(snapshotId, userId)
      return res.json({ ok: true, message: 'Snapshot deleted' })
    } catch (e) {
      const err = e as Error
      if (err.message.includes('not found')) {
        return res.status(404).json({
          ok: false,
          error: { code: 'NOT_FOUND', message: err.message }
        })
      }
      if (err.message.includes('locked')) {
        return res.status(403).json({
          ok: false,
          error: { code: 'FORBIDDEN', message: err.message }
        })
      }
      return res.status(500).json({
        ok: false,
        error: { code: 'SNAPSHOT_DELETE_ERROR', message: err.message }
      })
    }
  })

  // Lock/unlock a snapshot
  r.patch('/api/snapshots/:id/lock', rbacGuard('permissions', 'write'), async (req: Request, res: Response) => {
    const snapshotId = req.params.id
    const userId = getUserId(req)
    const { locked } = req.body

    if (typeof locked !== 'boolean') {
      return res.status(400).json({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'locked must be a boolean' }
      })
    }

    try {
      await snapshotService.setSnapshotLock(snapshotId, locked, userId)
      return res.json({ ok: true, message: `Snapshot ${locked ? 'locked' : 'unlocked'}` })
    } catch (e) {
      const err = e as Error
      return res.status(500).json({
        ok: false,
        error: { code: 'SNAPSHOT_LOCK_ERROR', message: err.message }
      })
    }
  })

  // Diff two snapshots
  r.get('/api/snapshots/diff', rbacGuard('permissions', 'read'), async (req: Request, res: Response) => {
    const snapshot1 = String(req.query.snapshot1 || '')
    const snapshot2 = String(req.query.snapshot2 || '')

    if (!snapshot1 || !snapshot2) {
      return res.status(400).json({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'snapshot1 and snapshot2 are required' }
      })
    }

    try {
      const diff = await snapshotService.diffSnapshots(snapshot1, snapshot2)
      return res.json({
        ok: true,
        data: {
          summary: {
            added: diff.added.length,
            removed: diff.removed.length,
            modified: diff.modified.length,
            unchanged: diff.unchanged
          },
          details: diff
        }
      })
    } catch (e) {
      const err = e as Error
      return res.status(500).json({
        ok: false,
        error: { code: 'SNAPSHOT_DIFF_ERROR', message: err.message }
      })
    }
  })

  // Cleanup expired snapshots
  r.post('/api/snapshots/cleanup', rbacGuard('permissions', 'write'), async (_req: Request, res: Response) => {
    try {
      const result = await snapshotService.cleanupExpired()
      return res.json({
        ok: true,
        data: result,
        message: `Cleaned up ${result.deleted} snapshots, freed ${result.freed} items`
      })
    } catch (e) {
      const err = e as Error
      return res.status(500).json({
        ok: false,
        error: { code: 'SNAPSHOT_CLEANUP_ERROR', message: err.message }
      })
    }
  })

  // Get snapshot statistics (allow admin or any authenticated user for observability)
  r.get('/api/snapstats', async (_req: Request, res: Response) => {
    try {
      const stats = await snapshotService.getStats()
      return res.json({ ok: true, data: stats })
    } catch (e) {
      const err = e as Error
      return res.status(500).json({ ok: false, error: { code: 'SNAPSHOT_STATS_ERROR', message: err.message } })
    }
  })

  return r
}
