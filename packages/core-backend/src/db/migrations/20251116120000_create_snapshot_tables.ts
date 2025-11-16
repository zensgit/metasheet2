/**
 * Migration: Create Snapshot/Versioning Tables
 *
 * Purpose: Add tables for view state snapshots and version history
 * Tables: snapshots, snapshot_items
 * Breaking: No - Additive only
 *
 * This implements Phase 9 of the ROADMAP: Snapshot / Versioning MVP
 */

import { Kysely, sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<any>): Promise<void> {
  // 1. Create snapshots table
  const snapshotsExists = await checkTableExists(db, 'snapshots')

  if (!snapshotsExists) {
    console.log('[Migration] Creating table: snapshots')

    await db.schema
      .createTable('snapshots')
      .ifNotExists()
      .addColumn('id', 'text', col =>
        col.primaryKey().defaultTo(sql`gen_random_uuid()::text`)
      )
      .addColumn('view_id', 'text', col =>
        col.notNull()
      )
      .addColumn('name', 'text', col =>
        col.notNull()
      )
      .addColumn('description', 'text')
      .addColumn('version', 'integer', col =>
        col.notNull().defaultTo(1)
      )
      .addColumn('created_by', 'text', col =>
        col.notNull()
      )
      .addColumn('snapshot_type', 'text', col =>
        col.notNull().defaultTo('manual')
      )
      .addColumn('metadata', 'jsonb', col =>
        col.defaultTo(sql`'{}'::jsonb`)
      )
      .addColumn('is_locked', 'boolean', col =>
        col.notNull().defaultTo(false)
      )
      .addColumn('parent_snapshot_id', 'text')
      .addColumn('created_at', 'timestamptz', col =>
        col.notNull().defaultTo(sql`NOW()`)
      )
      .addColumn('expires_at', 'timestamptz')
      .execute()

    console.log('[Migration] Table snapshots created')

    // Create indexes for snapshots
    await db.schema
      .createIndex('idx_snapshots_view_id')
      .ifNotExists()
      .on('snapshots')
      .column('view_id')
      .execute()

    await db.schema
      .createIndex('idx_snapshots_created_by')
      .ifNotExists()
      .on('snapshots')
      .column('created_by')
      .execute()

    await db.schema
      .createIndex('idx_snapshots_created_at')
      .ifNotExists()
      .on('snapshots')
      .column('created_at')
      .execute()

    await db.schema
      .createIndex('idx_snapshots_view_version')
      .ifNotExists()
      .on('snapshots')
      .columns(['view_id', 'version'])
      .execute()

    console.log('[Migration] Snapshots indexes created')
  } else {
    console.log('[Migration] Table snapshots already exists, skipping')
  }

  // 2. Create snapshot_items table (stores the actual data)
  const itemsExists = await checkTableExists(db, 'snapshot_items')

  if (!itemsExists) {
    console.log('[Migration] Creating table: snapshot_items')

    await db.schema
      .createTable('snapshot_items')
      .ifNotExists()
      .addColumn('id', 'text', col =>
        col.primaryKey().defaultTo(sql`gen_random_uuid()::text`)
      )
      .addColumn('snapshot_id', 'text', col =>
        col.notNull()
      )
      .addColumn('item_type', 'text', col =>
        col.notNull()
      )
      .addColumn('item_id', 'text', col =>
        col.notNull()
      )
      .addColumn('data', 'jsonb', col =>
        col.notNull()
      )
      .addColumn('checksum', 'text')
      .addColumn('created_at', 'timestamptz', col =>
        col.notNull().defaultTo(sql`NOW()`)
      )
      .execute()

    console.log('[Migration] Table snapshot_items created')

    // Create indexes for snapshot_items
    await db.schema
      .createIndex('idx_snapshot_items_snapshot_id')
      .ifNotExists()
      .on('snapshot_items')
      .column('snapshot_id')
      .execute()

    await db.schema
      .createIndex('idx_snapshot_items_type')
      .ifNotExists()
      .on('snapshot_items')
      .column('item_type')
      .execute()

    await db.schema
      .createIndex('idx_snapshot_items_composite')
      .ifNotExists()
      .on('snapshot_items')
      .columns(['snapshot_id', 'item_type'])
      .execute()

    console.log('[Migration] Snapshot_items indexes created')
  } else {
    console.log('[Migration] Table snapshot_items already exists, skipping')
  }

  // 3. Create snapshot_restore_log table
  const logExists = await checkTableExists(db, 'snapshot_restore_log')

  if (!logExists) {
    console.log('[Migration] Creating table: snapshot_restore_log')

    await db.schema
      .createTable('snapshot_restore_log')
      .ifNotExists()
      .addColumn('id', 'text', col =>
        col.primaryKey().defaultTo(sql`gen_random_uuid()::text`)
      )
      .addColumn('snapshot_id', 'text', col =>
        col.notNull()
      )
      .addColumn('view_id', 'text', col =>
        col.notNull()
      )
      .addColumn('restored_by', 'text', col =>
        col.notNull()
      )
      .addColumn('restore_type', 'text', col =>
        col.notNull().defaultTo('full')
      )
      .addColumn('items_restored', 'integer', col =>
        col.notNull().defaultTo(0)
      )
      .addColumn('status', 'text', col =>
        col.notNull().defaultTo('success')
      )
      .addColumn('error_message', 'text')
      .addColumn('metadata', 'jsonb', col =>
        col.defaultTo(sql`'{}'::jsonb`)
      )
      .addColumn('created_at', 'timestamptz', col =>
        col.notNull().defaultTo(sql`NOW()`)
      )
      .execute()

    console.log('[Migration] Table snapshot_restore_log created')

    await db.schema
      .createIndex('idx_snapshot_restore_log_snapshot')
      .ifNotExists()
      .on('snapshot_restore_log')
      .column('snapshot_id')
      .execute()

    await db.schema
      .createIndex('idx_snapshot_restore_log_view')
      .ifNotExists()
      .on('snapshot_restore_log')
      .column('view_id')
      .execute()

    console.log('[Migration] Snapshot_restore_log indexes created')
  } else {
    console.log('[Migration] Table snapshot_restore_log already exists, skipping')
  }

  console.log('[Migration] Phase 9 Snapshot/Versioning tables created successfully')
}

export async function down(db: Kysely<any>): Promise<void> {
  console.log('[Migration] Rolling back: dropping snapshot tables')

  await db.schema
    .dropTable('snapshot_restore_log')
    .ifExists()
    .execute()

  await db.schema
    .dropTable('snapshot_items')
    .ifExists()
    .execute()

  await db.schema
    .dropTable('snapshots')
    .ifExists()
    .execute()

  console.log('[Migration] Snapshot tables dropped successfully')
}
