/**
 * Snapshot Service
 * Phase 9: Snapshot / Versioning MVP
 *
 * Provides functionality for creating and restoring view state snapshots.
 */

import { db } from '../db/db'
import { sql, type OnConflictBuilder } from 'kysely'
import { Logger } from '../core/logger'
import { metrics } from '../metrics/metrics'
import { auditLog } from '../audit/audit'
import crypto from 'crypto'
import type { Database } from '../db/types'
import { protectionRuleService } from './ProtectionRuleService'

export interface SnapshotCreateOptions {
  viewId: string
  name: string
  description?: string
  createdBy: string
  snapshotType?: 'manual' | 'auto' | 'pre_migration'
  metadata?: Record<string, unknown>
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
  metadata: Record<string, unknown>
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
  data: unknown
  checksum?: string
  created_at: Date
}

// Database result types
interface VersionResult {
  version: number
  id?: string
}

interface CountResult {
  count: string | number
}

interface DateResult {
  created_at: Date
}

interface TypeStatsResult {
  snapshot_type: string
  count: string | number
}

interface ProtectionLevelResult {
  id: string
  view_id: string
  protection_level: 'normal' | 'protected' | 'critical' | null
}

interface DbSnapshotItem {
  id: string
  snapshot_id: string
  item_type: string
  item_id: string
  data: string
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
    // Prometheus timer helper; ensures duration is recorded even on failure
    const stopTimer = (() => {
      try {
        const end = (label: 'create' | 'restore', startMs: number) => {
          const duration = (Date.now() - startMs) / 1000
          try { metrics.snapshotOperationDuration.labels(label).observe(duration) } catch { /* metrics unavailable */ }
          return duration
        }
        return (label: 'create' | 'restore') => end(label, startTime)
      } catch { /* timer setup failure - use fallback */
        return (_label: 'create' | 'restore') => (Date.now() - startTime) / 1000
      }
    })()

    if (!db) {
      throw new Error('Database not available')
    }

    this.logger.info(`Creating snapshot for view: ${options.viewId}`)

    try {
      // Get current version for this view
      const lastSnapshot = await db
        .selectFrom('snapshots')
        .select('version')
        .where('view_id', '=', options.viewId)
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst() as VersionResult | undefined

      const newVersion = lastSnapshot ? lastSnapshot.version + 1 : 1

      // Create snapshot record
      // NullableTimestamp expects string | undefined for insert, convert Date to ISO string
      const expiresAtValue = options.expiresAt ? options.expiresAt.toISOString() : undefined

      const snapshot = await db
        .insertInto('snapshots')
        .values({
          view_id: options.viewId,
          name: options.name,
          description: options.description || null,
          version: newVersion,
          created_by: options.createdBy,
          snapshot_type: options.snapshotType || 'manual',
          metadata: JSON.stringify(options.metadata || {}),
          is_locked: false,
          parent_snapshot_id: lastSnapshot?.id || null,
          expires_at: expiresAtValue,
          tags: [],
          protection_level: 'normal',
          release_channel: null
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      // Capture view state data
      const itemsCreated = await this.captureViewState(snapshot.id as string, options.viewId)

      // Record metrics
      const duration = stopTimer('create')
      try { metrics.snapshotCreateTotal.labels('success').inc() } catch { /* metrics unavailable */ }

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
      stopTimer('create')
      try { metrics.snapshotCreateTotal.labels('failure').inc() } catch { /* metrics unavailable */ }

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
      .selectFrom('views')
      .selectAll()
      .where('id', '=', viewId)
      .executeTakeFirst()

    if (view) {
      await this.saveSnapshotItem(snapshotId, 'view', viewId, view)
      itemsCreated++
    }

    // Capture view states
    const viewStates = await db
      .selectFrom('view_states')
      .selectAll()
      .where('view_id', '=', viewId)
      .execute()

    for (const state of viewStates) {
      await this.saveSnapshotItem(snapshotId, 'view_state', state.id, state)
      itemsCreated++
    }

    // Capture table rows (if applicable)
    try {
      const tableRows = await db
        .selectFrom('table_rows')
        .selectAll()
        .where('table_id', '=', viewId)
        .limit(10000) // Safety limit
        .execute()

      for (const row of tableRows) {
        await this.saveSnapshotItem(snapshotId, 'table_row', row.id, row)
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
    data: unknown
  ): Promise<void> {
    if (!db) {
      throw new Error('Database not available')
    }

    const dataString = JSON.stringify(data)
    const checksum = crypto.createHash('sha256').update(dataString).digest('hex')

    await db
      .insertInto('snapshot_items')
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
    const stopTimer = (() => {
      try {
        const end = (label: 'create' | 'restore', startMs: number) => {
          const duration = (Date.now() - startMs) / 1000
          try { metrics.snapshotOperationDuration.labels(label).observe(duration) } catch { /* metrics unavailable */ }
          return duration
        }
        return (label: 'create' | 'restore') => end(label, startTime)
      } catch { /* timer setup failure - use fallback */
        return (_label: 'create' | 'restore') => (Date.now() - startTime) / 1000
      }
    })()

    if (!db) {
      throw new Error('Database not available')
    }

    this.logger.info(`Restoring snapshot: ${options.snapshotId}`)

    try {
      // Get snapshot info
      const snapshot = await db
        .selectFrom('snapshots')
        .selectAll()
        .where('id', '=', options.snapshotId)
        .executeTakeFirst()

      if (!snapshot) {
        throw new Error(`Snapshot not found: ${options.snapshotId}`)
      }

      if (snapshot.is_locked) {
        throw new Error('Snapshot is locked and cannot be restored')
      }

      // Check protection rules
      const protectionResult = await protectionRuleService.evaluateRules({
        entity_type: 'snapshot',
        entity_id: options.snapshotId,
        operation: 'restore',
        properties: {
          ...snapshot,
          tags: snapshot.tags || [],
          protection_level: snapshot.protection_level || 'normal',
          release_channel: snapshot.release_channel
        },
        user_id: options.restoredBy
      })

      if (protectionResult.matched && protectionResult.effects?.action === 'block') {
        throw new Error(`Snapshot restore blocked by rule: ${protectionResult.rule_name}`)
      }

      // Get snapshot items
      let itemsQuery = db
        .selectFrom('snapshot_items')
        .selectAll()
        .where('snapshot_id', '=', options.snapshotId)

      if (options.itemTypes && options.itemTypes.length > 0) {
        itemsQuery = itemsQuery.where('item_type', 'in', options.itemTypes)
      }

      const items = await itemsQuery.execute() as DbSnapshotItem[]

      let itemsRestored = 0

      // Restore items by type
      for (const item of items) {
        try {
          const data = JSON.parse(item.data) as Record<string, unknown>
          await this.restoreItem(item.item_type, item.item_id, data)
          itemsRestored++
        } catch (err) {
          this.logger.warn(`Failed to restore item ${item.id}`, err as Error)
        }
      }

      const duration = stopTimer('restore')

      // Log restore operation
      await db
        .insertInto('snapshot_restore_log')
        .values({
          snapshot_id: options.snapshotId,
          view_id: snapshot.view_id,
          restored_by: options.restoredBy,
          restore_type: options.restoreType || 'full',
          items_restored: itemsRestored,
          status: 'success',
          error_message: null,
          metadata: JSON.stringify({ duration })
        })
        .execute()

      // Record metrics
      try { metrics.snapshotRestoreTotal.labels('success').inc() } catch { /* metrics unavailable */ }

      // Audit log
      await auditLog({
        actorId: options.restoredBy,
        actorType: 'user',
        action: 'restore',
        resourceType: 'snapshot',
        resourceId: options.snapshotId,
        meta: {
          viewId: snapshot.view_id,
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
      stopTimer('restore')
      try { metrics.snapshotRestoreTotal.labels('failure').inc() } catch { /* metrics unavailable */ }

      // Log failure
      if (db) {
        try {
          await db
            .insertInto('snapshot_restore_log')
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
        } catch { /* restore log failure - non-critical */ }
      }

      this.logger.error('Failed to restore snapshot', err)
      throw err
    }
  }

  /**
   * Restore a single item
   */
  private async restoreItem(itemType: string, itemId: string, data: Record<string, unknown>): Promise<void> {
    if (!db) {
      throw new Error('Database not available')
    }

    // Cast data to any for dynamic restore operations - the data was originally
    // captured from these tables so it should be compatible
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const insertData = data as any

    switch (itemType) {
      case 'view':
        await db
          .updateTable('views')
          .set(insertData)
          .where('id', '=', itemId)
          .execute()
        break

      case 'view_state':
        await db
          .insertInto('view_states')
          .values(insertData)
          .onConflict((oc: OnConflictBuilder<Database, 'view_states'>) => oc.column('id').doUpdateSet(insertData))
          .execute()
        break

      case 'table_row':
        await db
          .insertInto('table_rows')
          .values(insertData)
          .onConflict((oc: OnConflictBuilder<Database, 'table_rows'>) => oc.column('id').doUpdateSet(insertData))
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
      .selectFrom('snapshots')
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
      .selectFrom('snapshots')
      .selectAll()
      .where('id', '=', snapshotId)
      .executeTakeFirst()

    return (snapshot as Snapshot) || null
  }

  /**
   * Get all items for a snapshot
   */
  async getSnapshotItems(snapshotId: string): Promise<Array<SnapshotItem & { view_id?: string }>> {
    if (!db) {
      throw new Error('Database not available')
    }

    const items = await db
      .selectFrom('snapshot_items')
      .selectAll()
      .where('snapshot_id', '=', snapshotId)
      .execute() as DbSnapshotItem[]

    return items.map(item => ({
      id: item.id,
      snapshot_id: item.snapshot_id,
      item_type: item.item_type,
      item_id: item.item_id,
      data: JSON.parse(item.data) as unknown,
      checksum: item.checksum,
      created_at: item.created_at,
      // Extract view_id from data if present (for view and view_state items)
      view_id: (() => {
        try {
          const parsed = JSON.parse(item.data) as Record<string, unknown>
          return (parsed.view_id as string) || (parsed.id as string) || undefined
        } catch {
          return undefined
        }
      })()
    }))
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

    // Check protection rules
    const protectionResult = await protectionRuleService.evaluateRules({
      entity_type: 'snapshot',
      entity_id: snapshotId,
      operation: 'delete',
      properties: {
        ...snapshot,
        tags: snapshot.tags || [],
        protection_level: snapshot.protection_level || 'normal',
        release_channel: snapshot.release_channel
      },
      user_id: deletedBy
    })

    if (protectionResult.matched && protectionResult.effects?.action === 'block') {
      throw new Error(`Snapshot deletion blocked by rule: ${protectionResult.rule_name}`)
    }

    // Delete items first
    await db
      .deleteFrom('snapshot_items')
      .where('snapshot_id', '=', snapshotId)
      .execute()

    // Delete snapshot
    await db
      .deleteFrom('snapshots')
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
      .updateTable('snapshots')
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

  async updateSnapshot(snapshotId: string, updates: { expires_at?: Date | null }): Promise<boolean> {
    if (!db) {
      throw new Error('Database not available')
    }

    const patch: { expires_at?: string | null } = {}
    if (Object.prototype.hasOwnProperty.call(updates, 'expires_at')) {
      patch.expires_at = updates.expires_at ? updates.expires_at.toISOString() : null
    }

    if (Object.keys(patch).length === 0) {
      return false
    }

    await db
      .updateTable('snapshots')
      .set(patch)
      .where('id', '=', snapshotId)
      .execute()

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
      .selectFrom('snapshots')
      .select(['id', 'view_id', 'protection_level'])
      .where('expires_at', '<', now)
      .where('is_locked', '=', false)
      .execute() as ProtectionLevelResult[]

    // Filter out protected and critical snapshots
    const deletableSnapshots = expiredSnapshots.filter(
      (s) => s.protection_level !== 'protected' && s.protection_level !== 'critical'
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
      } catch { /* metrics unavailable */ }
      return { deleted: 0, freed: 0, skipped: skippedCount }
    }

    let totalItemsFreed = 0

    for (const snapshot of deletableSnapshots) {
      // Count items before deletion
      const itemCount = await db
        .selectFrom('snapshot_items')
        .select(db.fn.count('id').as('count'))
        .where('snapshot_id', '=', snapshot.id)
        .executeTakeFirst() as CountResult | undefined

      totalItemsFreed += Number(itemCount?.count || 0)

      // Delete items
      await db
        .deleteFrom('snapshot_items')
        .where('snapshot_id', '=', snapshot.id)
        .execute()

      // Delete snapshot
      await db
        .deleteFrom('snapshots')
        .where('id', '=', snapshot.id)
        .execute()
    }

    try {
      metrics.snapshotCleanupTotal.labels('success').inc()
      if (skippedCount > 0) {
        metrics.snapshotProtectedSkippedTotal.inc(skippedCount)
      }
    } catch { /* metrics unavailable */ }

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
      .selectFrom('snapshot_items')
      .selectAll()
      .where('snapshot_id', '=', snapshotId1)
      .execute() as DbSnapshotItem[]

    const items2 = await db
      .selectFrom('snapshot_items')
      .selectAll()
      .where('snapshot_id', '=', snapshotId2)
      .execute() as DbSnapshotItem[]

    // Create maps for comparison
    const map1 = new Map<string, DbSnapshotItem>()
    const map2 = new Map<string, DbSnapshotItem>()

    for (const item of items1) {
      const key = `${item.item_type}:${item.item_id}`
      map1.set(key, item)
    }

    for (const item of items2) {
      const key = `${item.item_type}:${item.item_id}`
      map2.set(key, item)
    }

    const added: SnapshotItem[] = []
    const removed: SnapshotItem[] = []
    const modified: Array<{ before: SnapshotItem; after: SnapshotItem }> = []
    let unchanged = 0

    // Find added and modified items (in snapshot2 but not in snapshot1, or changed)
    for (const [key, item2] of map2.entries()) {
      if (!map1.has(key)) {
        added.push(this.parseSnapshotItem(item2))
      } else {
        const item1 = map1.get(key)!
        if (item1.checksum !== item2.checksum) {
          modified.push({
            before: this.parseSnapshotItem(item1),
            after: this.parseSnapshotItem(item2)
          })
        } else {
          unchanged++
        }
      }
    }

    // Find removed items (in snapshot1 but not in snapshot2)
    for (const [key, item1] of map1.entries()) {
      if (!map2.has(key)) {
        removed.push(this.parseSnapshotItem(item1))
      }
    }

    this.logger.info(
      `Diff result: +${added.length} -${removed.length} ~${modified.length} =${unchanged}`
    )

    return { added, removed, modified, unchanged }
  }

  /**
   * Parse database snapshot item to SnapshotItem
   */
  private parseSnapshotItem(dbItem: DbSnapshotItem): SnapshotItem {
    return {
      id: dbItem.id,
      snapshot_id: dbItem.snapshot_id,
      item_type: dbItem.item_type,
      item_id: dbItem.item_id,
      data: JSON.parse(dbItem.data) as unknown,
      checksum: dbItem.checksum,
      created_at: dbItem.created_at
    }
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
      .selectFrom('snapshots')
      .select(db.fn.count('id').as('count'))
      .executeTakeFirst() as CountResult | undefined

    const totalItems = await db
      .selectFrom('snapshot_items')
      .select(db.fn.count('id').as('count'))
      .executeTakeFirst() as CountResult | undefined

    const oldest = await db
      .selectFrom('snapshots')
      .select('created_at')
      .orderBy('created_at', 'asc')
      .limit(1)
      .executeTakeFirst() as DateResult | undefined

    const newest = await db
      .selectFrom('snapshots')
      .select('created_at')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst() as DateResult | undefined

    const expiredCount = await db
      .selectFrom('snapshots')
      .select(db.fn.count('id').as('count'))
      .where('expires_at', '<', new Date())
      .executeTakeFirst() as CountResult | undefined

    const lockedCount = await db
      .selectFrom('snapshots')
      .select(db.fn.count('id').as('count'))
      .where('is_locked', '=', true)
      .executeTakeFirst() as CountResult | undefined

    const typeStats = await db
      .selectFrom('snapshots')
      .select(['snapshot_type', db.fn.count('id').as('count')])
      .groupBy('snapshot_type')
      .execute() as TypeStatsResult[]

    const byType: Record<string, number> = {}
    for (const stat of typeStats) {
      byType[stat.snapshot_type] = Number(stat.count)
    }

    return {
      totalSnapshots: Number(totalSnapshots?.count || 0),
      totalItems: Number(totalItems?.count || 0),
      oldestSnapshot: oldest?.created_at || null,
      newestSnapshot: newest?.created_at || null,
      expiredCount: Number(expiredCount?.count || 0),
      lockedCount: Number(lockedCount?.count || 0),
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
        .set({ tags: mergedTags })
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
      } catch { /* metrics unavailable */ }

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
        .set({ tags: filteredTags })
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
      } catch { /* metrics unavailable */ }

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
      } catch { /* metrics unavailable */ }

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
      // Use PostgreSQL ANY overlap (&&) for at least one matching tag.
      // Build ARRAY[...] literal safely.
      // Cast sql expression to SqlBool for where clause compatibility
      const arrayLiteral = 'ARRAY[' + tags.map(t => `'${t.replace(/'/g, "''")}'`).join(',') + ']'
      const snapshots = await db
        .selectFrom('snapshots')
        .selectAll()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .where(sql`tags && ${sql.raw(arrayLiteral)}` as any)
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
