/**
 * Snapshot API Routes
 * Phase 9: Snapshot / Versioning MVP
 */

import type { Request, Response } from 'express';
import { Router } from 'express'
import { rbacGuard } from '../rbac/rbac'
import { snapshotService } from '../services/SnapshotService'

export function snapshotsRouter(): Router {
  const r = Router()

  // List snapshots for a view
  r.get('/api/snapshots', rbacGuard('permissions', 'read'), async (req: Request, res: Response) => {
    const viewId = String(req.query.view_id || '')
    if (!viewId) {
      return res.status(400).json({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'view_id is required' }
      })
    }

    try {
      const snapshots = await snapshotService.listSnapshots(viewId)
      return res.json({ ok: true, data: snapshots })
    } catch (e) {
      const err = e as Error
      return res.status(500).json({
        ok: false,
        error: { code: 'SNAPSHOT_LIST_ERROR', message: err.message }
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
    const userId = req.user?.id?.toString() || 'system'
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
    const userId = req.user?.id?.toString() || 'system'
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
    const userId = req.user?.id?.toString() || 'system'

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
    const userId = req.user?.id?.toString() || 'system'
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
