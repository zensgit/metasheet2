/**
 * Snapshot Service
 * Phase 9: Snapshot / Versioning MVP
 *
 * Provides functionality for creating and restoring view state snapshots.
 */

import { db } from '../db/db'
import { Logger } from '../core/logger'
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
  // Sprint 2: Protection labels
  tags?: string[]
  protection_level?: 'normal' | 'protected' | 'critical'
  release_channel?: 'stable' | 'canary' | 'beta' | 'experimental' | null
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
          .onConflict((oc: any) => oc.column('id').doUpdateSet(data))
          .execute()
        break

      case 'table_row':
        await db
          .insertInto('table_rows' as any)
          .values(data)
          .onConflict((oc: any) => oc.column('id').doUpdateSet(data))
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

  /**
   * Cleanup expired snapshots
   * Sprint 2: Skip protected and critical snapshots
   */
  async cleanupExpired(): Promise<{ deleted: number; freed: number; skipped: number }> {
    if (!db) {
      throw new Error('Database not available')
    }

    const now = new Date()
    this.logger.info('Starting expired snapshot cleanup')

    // Find expired snapshots (not locked, not protected/critical)
    const expiredSnapshots = await db
      .selectFrom('snapshots' as any)
      .select(['id', 'view_id', 'protection_level'])
      .where('expires_at', '<', now)
      .where('is_locked', '=', false)
      .execute()

    // Filter out protected and critical snapshots
    const deletableSnapshots = expiredSnapshots.filter(
      (s: any) => s.protection_level !== 'protected' && s.protection_level !== 'critical'
    )
    const skippedCount = expiredSnapshots.length - deletableSnapshots.length

    if (expiredSnapshots.length === 0) {
      this.logger.info('No expired snapshots found')
      return { deleted: 0, freed: 0, skipped: 0 }
    }

    if (deletableSnapshots.length === 0) {
      this.logger.info(`Found ${expiredSnapshots.length} expired snapshots, all protected - skipping`)
      try {
        metrics.snapshotProtectedSkippedTotal.inc(skippedCount)
      } catch {}
      return { deleted: 0, freed: 0, skipped: skippedCount }
    }

    let totalItemsFreed = 0

    for (const snapshot of deletableSnapshots) {
      // Count items before deletion
      const itemCount = await db
        .selectFrom('snapshot_items' as any)
        .select(db.fn.count('id').as('count'))
        .where('snapshot_id', '=', (snapshot as any).id)
        .executeTakeFirst()

      totalItemsFreed += Number((itemCount as any)?.count || 0)

      // Delete items
      await db
        .deleteFrom('snapshot_items' as any)
        .where('snapshot_id', '=', (snapshot as any).id)
        .execute()

      // Delete snapshot
      await db
        .deleteFrom('snapshots' as any)
        .where('id', '=', (snapshot as any).id)
        .execute()
    }

    try {
      metrics.snapshotCleanupTotal.labels('success').inc()
      if (skippedCount > 0) {
        metrics.snapshotProtectedSkippedTotal.inc(skippedCount)
      }
    } catch {}

    this.logger.info(
      `Cleanup completed: ${deletableSnapshots.length} snapshots deleted, ${totalItemsFreed} items freed, ${skippedCount} protected snapshots skipped`
    )

    return {
      deleted: deletableSnapshots.length,
      freed: totalItemsFreed,
      skipped: skippedCount
    }
  }

  /**
   * Compare two snapshots and return differences
   */
  async diffSnapshots(
    snapshotId1: string,
    snapshotId2: string
  ): Promise<{
    added: SnapshotItem[]
    removed: SnapshotItem[]
    modified: Array<{ before: SnapshotItem; after: SnapshotItem }>
    unchanged: number
  }> {
    if (!db) {
      throw new Error('Database not available')
    }

    // Get items from both snapshots
    const items1 = await db
      .selectFrom('snapshot_items' as any)
      .selectAll()
      .where('snapshot_id', '=', snapshotId1)
      .execute()

    const items2 = await db
      .selectFrom('snapshot_items' as any)
      .selectAll()
      .where('snapshot_id', '=', snapshotId2)
      .execute()

    // Create maps for comparison
    const map1 = new Map<string, any>()
    const map2 = new Map<string, any>()

    for (const item of items1) {
      const key = `${(item as any).item_type}:${(item as any).item_id}`
      map1.set(key, item)
    }

    for (const item of items2) {
      const key = `${(item as any).item_type}:${(item as any).item_id}`
      map2.set(key, item)
    }

    const added: SnapshotItem[] = []
    const removed: SnapshotItem[] = []
    const modified: Array<{ before: SnapshotItem; after: SnapshotItem }> = []
    let unchanged = 0

    // Find added and modified items (in snapshot2 but not in snapshot1, or changed)
    for (const [key, item2] of map2.entries()) {
      if (!map1.has(key)) {
        added.push(item2 as SnapshotItem)
      } else {
        const item1 = map1.get(key)
        if ((item1 as any).checksum !== (item2 as any).checksum) {
          modified.push({
            before: item1 as SnapshotItem,
            after: item2 as SnapshotItem
          })
        } else {
          unchanged++
        }
      }
    }

    // Find removed items (in snapshot1 but not in snapshot2)
    for (const [key, item1] of map1.entries()) {
      if (!map2.has(key)) {
        removed.push(item1 as SnapshotItem)
      }
    }

    this.logger.info(
      `Diff result: +${added.length} -${removed.length} ~${modified.length} =${unchanged}`
    )

    return { added, removed, modified, unchanged }
  }

  /**
   * Get snapshot statistics
   */
  async getStats(): Promise<{
    totalSnapshots: number
    totalItems: number
    oldestSnapshot: Date | null
    newestSnapshot: Date | null
    expiredCount: number
    lockedCount: number
    byType: Record<string, number>
  }> {
    if (!db) {
      throw new Error('Database not available')
    }

    const totalSnapshots = await db
      .selectFrom('snapshots' as any)
      .select(db.fn.count('id').as('count'))
      .executeTakeFirst()

    const totalItems = await db
      .selectFrom('snapshot_items' as any)
      .select(db.fn.count('id').as('count'))
      .executeTakeFirst()

    const oldest = await db
      .selectFrom('snapshots' as any)
      .select('created_at')
      .orderBy('created_at', 'asc')
      .limit(1)
      .executeTakeFirst()

    const newest = await db
      .selectFrom('snapshots' as any)
      .select('created_at')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst()

    const expiredCount = await db
      .selectFrom('snapshots' as any)
      .select(db.fn.count('id').as('count'))
      .where('expires_at', '<', new Date())
      .executeTakeFirst()

    const lockedCount = await db
      .selectFrom('snapshots' as any)
      .select(db.fn.count('id').as('count'))
      .where('is_locked', '=', true)
      .executeTakeFirst()

    const typeStats = await db
      .selectFrom('snapshots' as any)
      .select(['snapshot_type', db.fn.count('id').as('count')])
      .groupBy('snapshot_type')
      .execute()

    const byType: Record<string, number> = {}
    for (const stat of typeStats) {
      byType[(stat as any).snapshot_type] = Number((stat as any).count)
    }

    return {
      totalSnapshots: Number((totalSnapshots as any)?.count || 0),
      totalItems: Number((totalItems as any)?.count || 0),
      oldestSnapshot: (oldest as any)?.created_at || null,
      newestSnapshot: (newest as any)?.created_at || null,
      expiredCount: Number((expiredCount as any)?.count || 0),
      lockedCount: Number((lockedCount as any)?.count || 0),
      byType
    }
  }

  // ============================================
  // SPRINT 2: SNAPSHOT LABEL MANAGEMENT
  // ============================================

  /**
   * Add tags to a snapshot
   */
  async addTags(snapshotId: string, tags: string[], userId: string): Promise<boolean> {
    if (!db) {
      throw new Error('Database not available')
    }

    this.logger.info(`Adding tags to snapshot ${snapshotId}: ${tags.join(', ')}`)

    try {
      const snapshot = await this.getSnapshot(snapshotId)
      if (!snapshot) {
        throw new Error(`Snapshot not found: ${snapshotId}`)
      }

      // Get existing tags
      const existingTags = snapshot.tags || []

      // Merge with new tags (avoid duplicates)
      const mergedTags = Array.from(new Set([...existingTags, ...tags]))

      // Update snapshot
      await db
        .updateTable('snapshots')
        .set({ tags: mergedTags as any })
        .where('id', '=', snapshotId)
        .execute()

      // Audit log
      await auditLog({
        actorId: userId,
        actorType: 'user',
        action: 'add_tags',
        resourceType: 'snapshot',
        resourceId: snapshotId,
        meta: { tags, totalTags: mergedTags.length }
      })

      // Record metrics
      try {
        for (const tag of tags) {
          metrics.snapshotTagsTotal.labels(tag).inc()
        }
      } catch {}

      this.logger.info(`Tags added to snapshot ${snapshotId}`)
      return true
    } catch (error) {
      this.logger.error('Failed to add tags', error as Error)
      throw error
    }
  }

  /**
   * Remove tags from a snapshot
   */
  async removeTags(snapshotId: string, tags: string[], userId: string): Promise<boolean> {
    if (!db) {
      throw new Error('Database not available')
    }

    this.logger.info(`Removing tags from snapshot ${snapshotId}: ${tags.join(', ')}`)

    try {
      const snapshot = await this.getSnapshot(snapshotId)
      if (!snapshot) {
        throw new Error(`Snapshot not found: ${snapshotId}`)
      }

      // Get existing tags
      const existingTags = snapshot.tags || []

      // Remove specified tags
      const filteredTags = existingTags.filter(tag => !tags.includes(tag))

      // Update snapshot
      await db
        .updateTable('snapshots')
        .set({ tags: filteredTags as any })
        .where('id', '=', snapshotId)
        .execute()

      // Audit log
      await auditLog({
        actorId: userId,
        actorType: 'user',
        action: 'remove_tags',
        resourceType: 'snapshot',
        resourceId: snapshotId,
        meta: { tags, remainingTags: filteredTags.length }
      })

      this.logger.info(`Tags removed from snapshot ${snapshotId}`)
      return true
    } catch (error) {
      this.logger.error('Failed to remove tags', error as Error)
      throw error
    }
  }

  /**
   * Set protection level for a snapshot
   */
  async setProtectionLevel(
    snapshotId: string,
    level: 'normal' | 'protected' | 'critical',
    userId: string
  ): Promise<boolean> {
    if (!db) {
      throw new Error('Database not available')
    }

    this.logger.info(`Setting protection level for snapshot ${snapshotId}: ${level}`)

    try {
      await db
        .updateTable('snapshots')
        .set({ protection_level: level })
        .where('id', '=', snapshotId)
        .execute()

      // Audit log
      await auditLog({
        actorId: userId,
        actorType: 'user',
        action: 'set_protection_level',
        resourceType: 'snapshot',
        resourceId: snapshotId,
        meta: { protection_level: level }
      })

      // Record metrics
      try {
        metrics.snapshotProtectionLevel.labels(level).set(1)
      } catch {}

      this.logger.info(`Protection level set for snapshot ${snapshotId}: ${level}`)
      return true
    } catch (error) {
      this.logger.error('Failed to set protection level', error as Error)
      throw error
    }
  }

  /**
   * Set release channel for a snapshot
   */
  async setReleaseChannel(
    snapshotId: string,
    channel: 'stable' | 'canary' | 'beta' | 'experimental' | null,
    userId: string
  ): Promise<boolean> {
    if (!db) {
      throw new Error('Database not available')
    }

    this.logger.info(`Setting release channel for snapshot ${snapshotId}: ${channel}`)

    try {
      await db
        .updateTable('snapshots')
        .set({ release_channel: channel })
        .where('id', '=', snapshotId)
        .execute()

      // Audit log
      await auditLog({
        actorId: userId,
        actorType: 'user',
        action: 'set_release_channel',
        resourceType: 'snapshot',
        resourceId: snapshotId,
        meta: { release_channel: channel }
      })

      // Record metrics
      try {
        if (channel) {
          metrics.snapshotReleaseChannel.labels(channel).set(1)
        }
      } catch {}

      this.logger.info(`Release channel set for snapshot ${snapshotId}: ${channel}`)
      return true
    } catch (error) {
      this.logger.error('Failed to set release channel', error as Error)
      throw error
    }
  }

  /**
   * Query snapshots by tags
   */
  async getByTags(tags: string[]): Promise<Snapshot[]> {
    if (!db) {
      throw new Error('Database not available')
    }

    try {
      // Use PostgreSQL array contains operator
      const snapshots = await db
        .selectFrom('snapshots')
        .selectAll()
        .where('tags', '@>', JSON.stringify(tags) as any)
        .orderBy('created_at', 'desc')
        .execute()

      return snapshots as Snapshot[]
    } catch (error) {
      this.logger.error('Failed to query snapshots by tags', error as Error)
      throw error
    }
  }

  /**
   * Query snapshots by protection level
   */
  async getByProtectionLevel(level: 'normal' | 'protected' | 'critical'): Promise<Snapshot[]> {
    if (!db) {
      throw new Error('Database not available')
    }

    try {
      const snapshots = await db
        .selectFrom('snapshots')
        .selectAll()
        .where('protection_level', '=', level)
        .orderBy('created_at', 'desc')
        .execute()

      return snapshots as Snapshot[]
    } catch (error) {
      this.logger.error('Failed to query snapshots by protection level', error as Error)
      throw error
    }
  }

  /**
   * Query snapshots by release channel
   */
  async getByReleaseChannel(
    channel: 'stable' | 'canary' | 'beta' | 'experimental'
  ): Promise<Snapshot[]> {
    if (!db) {
      throw new Error('Database not available')
    }

    try {
      const snapshots = await db
        .selectFrom('snapshots')
        .selectAll()
        .where('release_channel', '=', channel)
        .orderBy('created_at', 'desc')
        .execute()

      return snapshots as Snapshot[]
    } catch (error) {
      this.logger.error('Failed to query snapshots by release channel', error as Error)
      throw error
    }
  }
}

// Singleton instance
export const snapshotService = new SnapshotService()
