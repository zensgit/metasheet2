/**
 * Snapshot Service
 * Phase 9: Snapshot / Versioning MVP
 *
 * Provides functionality for creating and restoring view state snapshots.
 */

import { db } from '../db/db'
import { Logger } from '../core/Logger'
import { metrics } from '../metrics/metrics'
import { auditLog } from '../audit/audit'
import crypto from 'crypto'

export interface SnapshotCreateOptions {
  viewId: string
  name: string
  description?: string
  createdBy: string
  snapshotType?: 'manual' | 'auto' | 'pre_migration'
  metadata?: Record<string, any>
  expiresAt?: Date
}

export interface SnapshotRestoreOptions {
  snapshotId: string
  restoredBy: string
  restoreType?: 'full' | 'partial' | 'selective'
  itemTypes?: string[]
}

export interface Snapshot {
  id: string
  view_id: string
  name: string
  description?: string
  version: number
  created_by: string
  snapshot_type: string
  metadata: Record<string, any>
  is_locked: boolean
  parent_snapshot_id?: string
  created_at: Date
  expires_at?: Date
}

export interface SnapshotItem {
  id: string
  snapshot_id: string
  item_type: string
  item_id: string
  data: any
  checksum?: string
  created_at: Date
}

export class SnapshotService {
  private logger: Logger

  constructor() {
    this.logger = new Logger('SnapshotService')
  }

  /**
   * Create a new snapshot of a view
   */
  async createSnapshot(options: SnapshotCreateOptions): Promise<Snapshot> {
    const startTime = Date.now()

    if (!db) {
      throw new Error('Database not available')
    }

    this.logger.info(`Creating snapshot for view: ${options.viewId}`)

    try {
      // Get current version for this view
      const lastSnapshot = await db
        .selectFrom('snapshots' as any)
        .select('version')
        .where('view_id', '=', options.viewId)
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst()

      const newVersion = lastSnapshot ? (lastSnapshot as any).version + 1 : 1

      // Create snapshot record
      const snapshot = await db
        .insertInto('snapshots' as any)
        .values({
          view_id: options.viewId,
          name: options.name,
          description: options.description || null,
          version: newVersion,
          created_by: options.createdBy,
          snapshot_type: options.snapshotType || 'manual',
          metadata: JSON.stringify(options.metadata || {}),
          is_locked: false,
          parent_snapshot_id: lastSnapshot ? (lastSnapshot as any).id : null,
          expires_at: options.expiresAt || null
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      // Capture view state data
      const itemsCreated = await this.captureViewState(snapshot.id as string, options.viewId)

      // Record metrics
      const duration = (Date.now() - startTime) / 1000
      try {
        metrics.snapshotCreateTotal.labels('success').inc()
        metrics.snapshotOperationDuration.labels('create').observe(duration)
      } catch {}

      // Audit log
      await auditLog({
        actorId: options.createdBy,
        actorType: 'user',
        action: 'create',
        resourceType: 'snapshot',
        resourceId: snapshot.id as string,
        meta: {
          viewId: options.viewId,
          version: newVersion,
          itemsCreated,
          duration
        }
      })

      this.logger.info(`Snapshot created: ${snapshot.id}, version: ${newVersion}, items: ${itemsCreated}`)

      return snapshot as Snapshot
    } catch (error) {
      const err = error as Error
      try {
        metrics.snapshotCreateTotal.labels('failure').inc()
      } catch {}

      this.logger.error('Failed to create snapshot', err)
      throw err
    }
  }

  /**
   * Capture the current state of a view
   */
  private async captureViewState(snapshotId: string, viewId: string): Promise<number> {
    if (!db) {
      throw new Error('Database not available')
    }

    let itemsCreated = 0

    // Capture view metadata
    const view = await db
      .selectFrom('views' as any)
      .selectAll()
      .where('id', '=', viewId)
      .executeTakeFirst()

    if (view) {
      await this.saveSnapshotItem(snapshotId, 'view', viewId, view)
      itemsCreated++
    }

    // Capture view states
    const viewStates = await db
      .selectFrom('view_states' as any)
      .selectAll()
      .where('view_id', '=', viewId)
      .execute()

    for (const state of viewStates) {
      await this.saveSnapshotItem(snapshotId, 'view_state', (state as any).id, state)
      itemsCreated++
    }

    // Capture table rows (if applicable)
    try {
      const tableRows = await db
        .selectFrom('table_rows' as any)
        .selectAll()
        .where('view_id', '=', viewId)
        .limit(10000) // Safety limit
        .execute()

      for (const row of tableRows) {
        await this.saveSnapshotItem(snapshotId, 'table_row', (row as any).id, row)
        itemsCreated++
      }
    } catch {
      // Table might not exist, skip
    }

    return itemsCreated
  }

  /**
   * Save a single item to the snapshot
   */
  private async saveSnapshotItem(
    snapshotId: string,
    itemType: string,
    itemId: string,
    data: any
  ): Promise<void> {
    if (!db) {
      throw new Error('Database not available')
    }

    const dataString = JSON.stringify(data)
    const checksum = crypto.createHash('sha256').update(dataString).digest('hex')

    await db
      .insertInto('snapshot_items' as any)
      .values({
        snapshot_id: snapshotId,
        item_type: itemType,
        item_id: itemId,
        data: dataString,
        checksum
      })
      .execute()
  }

  /**
   * Restore a snapshot
   */
  async restoreSnapshot(options: SnapshotRestoreOptions): Promise<{
    success: boolean
    itemsRestored: number
    duration: number
  }> {
    const startTime = Date.now()

    if (!db) {
      throw new Error('Database not available')
    }

    this.logger.info(`Restoring snapshot: ${options.snapshotId}`)

    try {
      // Get snapshot info
      const snapshot = await db
        .selectFrom('snapshots' as any)
        .selectAll()
        .where('id', '=', options.snapshotId)
        .executeTakeFirst()

      if (!snapshot) {
        throw new Error(`Snapshot not found: ${options.snapshotId}`)
      }

      if ((snapshot as any).is_locked) {
        throw new Error('Snapshot is locked and cannot be restored')
      }

      // Get snapshot items
      let itemsQuery = db
        .selectFrom('snapshot_items' as any)
        .selectAll()
        .where('snapshot_id', '=', options.snapshotId)

      if (options.itemTypes && options.itemTypes.length > 0) {
        itemsQuery = itemsQuery.where('item_type', 'in', options.itemTypes)
      }

      const items = await itemsQuery.execute()

      let itemsRestored = 0

      // Restore items by type
      for (const item of items) {
        try {
          const data = JSON.parse((item as any).data)
          await this.restoreItem((item as any).item_type, (item as any).item_id, data)
          itemsRestored++
        } catch (err) {
          this.logger.warn(`Failed to restore item ${(item as any).id}`, err as Error)
        }
      }

      const duration = (Date.now() - startTime) / 1000

      // Log restore operation
      await db
        .insertInto('snapshot_restore_log' as any)
        .values({
          snapshot_id: options.snapshotId,
          view_id: (snapshot as any).view_id,
          restored_by: options.restoredBy,
          restore_type: options.restoreType || 'full',
          items_restored: itemsRestored,
          status: 'success',
          metadata: JSON.stringify({ duration })
        })
        .execute()

      // Record metrics
      try {
        metrics.snapshotRestoreTotal.labels('success').inc()
        metrics.snapshotOperationDuration.labels('restore').observe(duration)
      } catch {}

      // Audit log
      await auditLog({
        actorId: options.restoredBy,
        actorType: 'user',
        action: 'restore',
        resourceType: 'snapshot',
        resourceId: options.snapshotId,
        meta: {
          viewId: (snapshot as any).view_id,
          itemsRestored,
          duration
        }
      })

      this.logger.info(`Snapshot restored: ${options.snapshotId}, items: ${itemsRestored}`)

      return {
        success: true,
        itemsRestored,
        duration
      }
    } catch (error) {
      const err = error as Error

      try {
        metrics.snapshotRestoreTotal.labels('failure').inc()
      } catch {}

      // Log failure
      if (db) {
        try {
          await db
            .insertInto('snapshot_restore_log' as any)
            .values({
              snapshot_id: options.snapshotId,
              view_id: 'unknown',
              restored_by: options.restoredBy,
              restore_type: options.restoreType || 'full',
              items_restored: 0,
              status: 'failed',
              error_message: err.message,
              metadata: JSON.stringify({})
            })
            .execute()
        } catch {}
      }

      this.logger.error('Failed to restore snapshot', err)
      throw err
    }
  }

  /**
   * Restore a single item
   */
  private async restoreItem(itemType: string, itemId: string, data: any): Promise<void> {
    if (!db) {
      throw new Error('Database not available')
    }

    switch (itemType) {
      case 'view':
        await db
          .updateTable('views' as any)
          .set(data)
          .where('id', '=', itemId)
          .execute()
        break

      case 'view_state':
        await db
          .insertInto('view_states' as any)
          .values(data)
          .onConflict(oc => oc.column('id').doUpdateSet(data))
          .execute()
        break

      case 'table_row':
        await db
          .insertInto('table_rows' as any)
          .values(data)
          .onConflict(oc => oc.column('id').doUpdateSet(data))
          .execute()
        break

      default:
        this.logger.warn(`Unknown item type: ${itemType}`)
    }
  }

  /**
   * List snapshots for a view
   */
  async listSnapshots(viewId: string): Promise<Snapshot[]> {
    if (!db) {
      throw new Error('Database not available')
    }

    const snapshots = await db
      .selectFrom('snapshots' as any)
      .selectAll()
      .where('view_id', '=', viewId)
      .orderBy('version', 'desc')
      .execute()

    return snapshots as Snapshot[]
  }

  /**
   * Get a specific snapshot
   */
  async getSnapshot(snapshotId: string): Promise<Snapshot | null> {
    if (!db) {
      throw new Error('Database not available')
    }

    const snapshot = await db
      .selectFrom('snapshots' as any)
      .selectAll()
      .where('id', '=', snapshotId)
      .executeTakeFirst()

    return (snapshot as Snapshot) || null
  }

  /**
   * Delete a snapshot
   */
  async deleteSnapshot(snapshotId: string, deletedBy: string): Promise<boolean> {
    if (!db) {
      throw new Error('Database not available')
    }

    const snapshot = await this.getSnapshot(snapshotId)
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${snapshotId}`)
    }

    if (snapshot.is_locked) {
      throw new Error('Cannot delete locked snapshot')
    }

    // Delete items first
    await db
      .deleteFrom('snapshot_items' as any)
      .where('snapshot_id', '=', snapshotId)
      .execute()

    // Delete snapshot
    await db
      .deleteFrom('snapshots' as any)
      .where('id', '=', snapshotId)
      .execute()

    // Audit log
    await auditLog({
      actorId: deletedBy,
      actorType: 'user',
      action: 'delete',
      resourceType: 'snapshot',
      resourceId: snapshotId,
      meta: {
        viewId: snapshot.view_id,
        version: snapshot.version
      }
    })

    this.logger.info(`Snapshot deleted: ${snapshotId}`)
    return true
  }

  /**
   * Lock/unlock a snapshot
   */
  async setSnapshotLock(snapshotId: string, locked: boolean, userId: string): Promise<boolean> {
    if (!db) {
      throw new Error('Database not available')
    }

    await db
      .updateTable('snapshots' as any)
      .set({ is_locked: locked })
      .where('id', '=', snapshotId)
      .execute()

    await auditLog({
      actorId: userId,
      actorType: 'user',
      action: locked ? 'lock' : 'unlock',
      resourceType: 'snapshot',
      resourceId: snapshotId,
      meta: {}
    })

    this.logger.info(`Snapshot ${snapshotId} ${locked ? 'locked' : 'unlocked'}`)
    return true
  }
}

// Singleton instance
export const snapshotService = new SnapshotService()
