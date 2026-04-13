/**
 * Migration: Create automation_rules table
 *
 * Purpose: Sheet-level automation rules that trigger actions when records change
 * Tables: automation_rules
 * Breaking: No
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const tableExists = await checkTableExists(db, 'automation_rules')

  if (tableExists) {
    console.log('[Migration] Table automation_rules already exists, skipping creation')
    return
  }

  console.log('[Migration] Creating table: automation_rules')

  await db.schema
    .createTable('automation_rules')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('sheet_id', 'text', (col) => col.notNull())
    .addColumn('name', 'text')
    .addColumn('trigger_type', 'text', (col) => col.notNull())
    .addColumn('trigger_config', 'jsonb', (col) => col.defaultTo(sql`'{}'::jsonb`))
    .addColumn('action_type', 'text', (col) => col.notNull())
    .addColumn('action_config', 'jsonb', (col) => col.defaultTo(sql`'{}'::jsonb`))
    .addColumn('enabled', 'boolean', (col) => col.defaultTo(true))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('created_by', 'text')
    .execute()

  // Add CHECK constraints via raw SQL
  await sql`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_trigger_type
    CHECK (trigger_type IN ('record.created', 'record.updated', 'field.changed'))
  `.execute(db)

  await sql`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_action_type
    CHECK (action_type IN ('notify', 'update_field'))
  `.execute(db)

  console.log('[Migration] Creating indexes...')

  await db.schema
    .createIndex('idx_automation_rules_sheet_enabled')
    .ifNotExists()
    .on('automation_rules')
    .columns(['sheet_id', 'enabled'])
    .execute()

  console.log('[Migration] Migration completed successfully')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  console.log('[Migration] Rolling back: dropping automation_rules')

  await db.schema
    .dropTable('automation_rules')
    .ifExists()
    .execute()

  console.log('[Migration] Rollback completed successfully')
}
