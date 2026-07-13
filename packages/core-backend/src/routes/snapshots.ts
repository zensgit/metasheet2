/**
 * Snapshot API Routes
 * Phase 9: Snapshot / Versioning MVP
 */

import type { Request, Response } from 'express';
import { Router } from 'express'
import { rbacGuard } from '../rbac/rbac'
import { requireAdminRole, protectAdminOperation, requireSafetyCheck, OperationType } from '../guards'
import { snapshotService, RESTORABLE_ITEM_TYPES, type RestorableItemType } from '../services/SnapshotService'
import { Logger } from '../core/logger'

const logger = new Logger('SnapshotsRouter')

type ProtectionLevel = 'normal' | 'protected' | 'critical'
type ReleaseChannel = 'stable' | 'canary' | 'beta' | 'experimental'

// SECURITY (GHSA-h8mf): identity comes ONLY from the authenticated principal. Every snapshot
// MUTATION below is gated by requireAdminRole(), which guarantees req.user is present; we never
// trust an `x-user-id` header and never fall back to a spoofable `system` identity. If req.user.id
// is somehow absent we fail rather than impersonate. (Defensive hardening: on the normal JWT chain
// req.user.id is always set on a successful auth, so the old fallback was largely unreachable — but
// removing it removes the ambiguity entirely.)
const getUserId = (req: Request): string => {
  const id = req.user?.id
  if (id === undefined || id === null || String(id).length === 0) {
    throw new Error('unauthenticated: snapshot mutation requires an authenticated req.user.id')
  }
  return String(id)
}

export function snapshotsRouter(): Router {
  const r = Router()

  // SECURITY (GHSA-h8mf): every snapshot MUTATION (create/restore/delete/lock-unlock/protection/
  // release-channel/tags/cleanup) is a privileged, side-effecting operation — a restore drives a
  // real write-back, and lock/protection changes gate whether a restore/delete is even possible.
  // The prior `rbacGuard('permissions','write')` granted any non-admin holding the `permissions:write`
  // code, so a low-privilege user could unlock-then-restore or trigger a destructive full restore.
  // We therefore raise ALL mutations to platform-admin via requireAdminRole() (the existing admin
  // safety guard: 403 for non-admin / 403 for no principal / 503 fail-closed if the RBAC check
  // itself throws — it never falls through). READ routes keep `permissions:read` (scope not widened).
  // org/view-scoped snapshot permissions are deferred to the later RBAC line; this is the
  // conservative platform-admin boundary.

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
  r.put('/api/snapshots/:id/tags', requireAdminRole(), async (req: Request, res: Response) => {
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
  r.patch('/api/snapshots/:id/protection', requireAdminRole(), async (req: Request, res: Response) => {
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
  r.patch('/api/snapshots/:id/release-channel', requireAdminRole(), async (req: Request, res: Response) => {
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
  r.post('/api/snapshots', requireAdminRole(), async (req: Request, res: Response) => {
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

  // SECURITY (GHSA-h8mf) SCOPE: the three legacy DESTRUCTIVE snapshot endpoints in this router —
  // restore (POST /api/snapshots/:id/restore, CRITICAL), delete (DELETE /api/snapshots/:id, MEDIUM),
  // and cleanup (POST /api/snapshots/cleanup, HIGH) — are ALL raised to the canonical admin safety stack
  // (protectAdminOperation + requireSafetyCheck). cleanup is included deliberately: it is a batch delete
  // whose canonical twin already uses the same stack, so leaving it on the old guard would keep a weaker
  // door open. Each of the three is annotated at its route below.

  // Restore a snapshot
  // SECURITY (GHSA-h8mf): this legacy endpoint reaches the SAME destructive primitive as the canonical
  // admin route (admin-routes.ts POST /api/admin/snapshots/:id/restore), so it must carry the SAME
  // security stack — platform-admin + audit (protectAdminOperation) AND the SafetyGuard confirmation
  // (requireSafetyCheck). RESTORE_SNAPSHOT is RiskLevel.CRITICAL. `confirm_full` below is an ordinary
  // request field for restore-SCOPE validation; it is NOT a safety token and cannot substitute for one.
  r.post(
    '/api/snapshots/:id/restore',
    ...protectAdminOperation(OperationType.RESTORE_SNAPSHOT),
    requireSafetyCheck({
      operation: OperationType.RESTORE_SNAPSHOT,
      getDetails: (req: Request) => ({ snapshotId: req.params.id })
    }),
    async (req: Request, res: Response) => {
    const snapshotId = req.params.id
    const userId = getUserId(req)
    const { restore_type, item_types, confirm_full } = req.body

    // SECURITY (GHSA-h8mf): validate the restore scope at the edge (defense-in-depth; SnapshotService
    // re-validates the same invariant authoritatively so other callers cannot bypass this). restore_type
    // is not a mere label — with no item_types the restore covers EVERYTHING — so bind the two:
    //   - restore_type must be explicitly 'full' | 'partial' | 'selective';
    //   - a 'full' restore must be explicitly confirmed (confirm_full === true) and must NOT narrow via item_types;
    //   - 'partial'/'selective' must carry a non-empty item_types drawn from RESTORABLE_ITEM_TYPES.
    if (restore_type !== 'full' && restore_type !== 'partial' && restore_type !== 'selective') {
      return res.status(400).json({
        ok: false,
        error: { code: 'BAD_REQUEST', message: "restore_type must be 'full', 'partial', or 'selective'" }
      })
    }
    if (restore_type === 'full') {
      if (confirm_full !== true) {
        return res.status(400).json({
          ok: false,
          error: { code: 'BAD_REQUEST', message: 'a full restore must be explicitly confirmed with confirm_full:true' }
        })
      }
      if (item_types !== undefined && !(Array.isArray(item_types) && item_types.length === 0)) {
        return res.status(400).json({
          ok: false,
          error: { code: 'BAD_REQUEST', message: "restore_type 'full' must not specify item_types" }
        })
      }
    } else {
      if (!Array.isArray(item_types) || item_types.length === 0) {
        return res.status(400).json({
          ok: false,
          error: { code: 'BAD_REQUEST', message: `restore_type '${restore_type}' requires a non-empty item_types array` }
        })
      }
      const invalid = item_types.filter((t: unknown) => !RESTORABLE_ITEM_TYPES.includes(t as RestorableItemType))
      if (invalid.length > 0) {
        return res.status(400).json({
          ok: false,
          error: { code: 'BAD_REQUEST', message: `item_types outside allowlist [${RESTORABLE_ITEM_TYPES.join(', ')}]: ${invalid.join(', ')}` }
        })
      }
    }

    try {
      const result = await snapshotService.restoreSnapshot({
        snapshotId,
        restoredBy: userId,
        restoreType: restore_type,
        itemTypes: restore_type === 'full' ? undefined : item_types
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
  // SECURITY (GHSA-h8mf): same reasoning as restore above — this legacy endpoint must carry the same
  // stack as its canonical twin (admin-routes.ts DELETE /api/admin/snapshots/:id): platform-admin +
  // audit AND the SafetyGuard confirmation. DELETE_SNAPSHOT is RiskLevel.MEDIUM.
  r.delete(
    '/api/snapshots/:id',
    ...protectAdminOperation(OperationType.DELETE_SNAPSHOT),
    requireSafetyCheck({
      operation: OperationType.DELETE_SNAPSHOT,
      getDetails: (req: Request) => ({ snapshotId: req.params.id })
    }),
    async (req: Request, res: Response) => {
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
  r.patch('/api/snapshots/:id/lock', requireAdminRole(), async (req: Request, res: Response) => {
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
  // SECURITY (GHSA-h8mf): cleanup deletes snapshots (RiskLevel.HIGH) and its canonical twin
  // (admin-routes.ts POST /api/admin/snapshots/cleanup) carries protectAdminOperation +
  // requireSafetyCheck — this legacy endpoint reuses the same stack rather than being the weak door.
  r.post(
    '/api/snapshots/cleanup',
    ...protectAdminOperation(OperationType.CLEANUP_SNAPSHOTS),
    requireSafetyCheck({ operation: OperationType.CLEANUP_SNAPSHOTS }),
    async (_req: Request, res: Response) => {
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
