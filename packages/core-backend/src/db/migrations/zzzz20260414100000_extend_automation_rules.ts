/**
 * Migration: Extend automation_rules table with V1 columns
 *
 * Purpose: Add conditions (JSONB) and actions (JSONB) columns, relax CHECK constraints
 *          to support new trigger/action types from the V1 automation system.
 * Tables: automation_rules (alter)
 * Breaking: No
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { addColumnIfNotExists, checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const tableExists = await checkTableExists(db, 'automation_rules')
  if (!tableExists) {
    console.log('[Migration] automation_rules table does not exist — skipping extension')
    return
  }

  console.log('[Migration] Extending automation_rules with V1 columns')

  // Add conditions column (JSONB, nullable)
  await addColumnIfNotExists(db, 'automation_rules', 'conditions', 'jsonb')

  // Add actions column (JSONB array, nullable)
  await addColumnIfNotExists(db, 'automation_rules', 'actions', 'jsonb')

  // Drop overly-restrictive CHECK constraints and replace with broader ones
  await sql`
    ALTER TABLE automation_rules
    DROP CONSTRAINT IF EXISTS chk_automation_trigger_type
  `.execute(db)

  await sql`
    ALTER TABLE automation_rules
    DROP CONSTRAINT IF EXISTS chk_automation_action_type
  `.execute(db)

  await sql`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_trigger_type
    CHECK (trigger_type IN (
      'record.created', 'record.updated', 'record.deleted',
      'field.changed', 'field.value_changed',
      'schedule.cron', 'schedule.interval',
      'webhook.received'
    ))
  `.execute(db)

  await sql`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_action_type
    CHECK (action_type IN (
      'notify', 'update_field',
      'update_record', 'create_record',
      'send_webhook', 'send_notification', 'lock_record'
    ))
  `.execute(db)

  console.log('[Migration] Extension completed successfully')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  console.log('[Migration] Rolling back automation_rules extension')

  // Drop expanded constraints and re-add original narrow ones
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_trigger_type`.execute(db)
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_action_type`.execute(db)

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

  // Drop added columns
  await sql`ALTER TABLE automation_rules DROP COLUMN IF EXISTS conditions`.execute(db)
  await sql`ALTER TABLE automation_rules DROP COLUMN IF EXISTS actions`.execute(db)

  console.log('[Migration] Rollback completed')
}
