/**
 * Migration: W6-1 — automation start_approval bridge
 *
 * Purpose: persist the durable linkage between one automation action job and
 * one approval-product instance. Completion is driven by W5 approval terminal
 * events, not by an admin resume token.
 * Tables: multitable_automation_approval_bridges (new) and action-type CHECK widen.
 * Breaking: No — new table plus additive action enum.
 */

import { sql, type Kysely } from 'kysely'
import { checkTableExists } from './_patterns'

export const AUTOMATION_ACTION_TYPES_WITH_START_APPROVAL = [
  'notify',
  'update_field',
  'update_record',
  'create_record',
  'send_webhook',
  'send_notification',
  'send_email',
  'send_dingtalk_group_message',
  'send_dingtalk_person_message',
  'lock_record',
  'wait_for_callback',
  'condition_branch',
  'start_approval',
] as const

export const AUTOMATION_ACTION_TYPES_BEFORE_START_APPROVAL = [
  'notify',
  'update_field',
  'update_record',
  'create_record',
  'send_webhook',
  'send_notification',
  'send_email',
  'send_dingtalk_group_message',
  'send_dingtalk_person_message',
  'lock_record',
  'wait_for_callback',
  'condition_branch',
] as const

function quotedActions(actions: readonly string[]): string {
  return actions.map((action) => `'${action}'`).join(', ')
}

async function replaceAutomationActionTypeConstraint(
  db: Kysely<unknown>,
  actions: readonly string[],
): Promise<void> {
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_action_type`.execute(db)
  await sql.raw(`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_action_type
    CHECK (action_type IN (${quotedActions(actions)}))
  `).execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'multitable_automation_approval_bridges')
  if (!exists) {
    await sql`
      CREATE TABLE IF NOT EXISTS multitable_automation_approval_bridges (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        root_execution_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        sheet_id TEXT,
        record_id TEXT,
        step_index INTEGER NOT NULL,
        approval_instance_id TEXT,
        approval_request_no TEXT,
        approval_template_id TEXT NOT NULL,
        approval_published_definition_id TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        outcome TEXT,
        action_fingerprint JSONB NOT NULL,
        trigger_event JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        resumed_at TIMESTAMPTZ
      )
    `.execute(db)

    await sql`
      CREATE INDEX IF NOT EXISTS idx_mt_auto_approval_bridges_execution_id
        ON multitable_automation_approval_bridges (execution_id)
    `.execute(db)
    await sql`
      CREATE INDEX IF NOT EXISTS idx_mt_auto_approval_bridges_root_step
        ON multitable_automation_approval_bridges (root_execution_id, step_index, approval_template_id)
    `.execute(db)
    await sql`
      CREATE INDEX IF NOT EXISTS idx_mt_auto_approval_bridges_pending_approval
        ON multitable_automation_approval_bridges (approval_instance_id)
        WHERE status = 'pending'
    `.execute(db)
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_mt_auto_approval_bridges_approval_instance
        ON multitable_automation_approval_bridges (approval_instance_id)
        WHERE approval_instance_id IS NOT NULL
    `.execute(db)
  }

  await sql`
    ALTER TABLE multitable_automation_approval_bridges
    DROP CONSTRAINT IF EXISTS chk_mt_auto_approval_bridge_status
  `.execute(db)
  await sql`
    ALTER TABLE multitable_automation_approval_bridges
    ADD CONSTRAINT chk_mt_auto_approval_bridge_status
    CHECK (status IN ('creating', 'pending', 'resumed', 'failed'))
  `.execute(db)
  await sql`
    ALTER TABLE multitable_automation_approval_bridges
    DROP CONSTRAINT IF EXISTS chk_mt_auto_approval_bridge_outcome
  `.execute(db)
  await sql`
    ALTER TABLE multitable_automation_approval_bridges
    ADD CONSTRAINT chk_mt_auto_approval_bridge_outcome
    CHECK (outcome IS NULL OR outcome IN ('approved', 'rejected', 'revoked', 'cancelled'))
  `.execute(db)
  await sql`
    ALTER TABLE multitable_automation_approval_bridges
    DROP CONSTRAINT IF EXISTS chk_mt_auto_approval_bridge_claimable_has_approval
  `.execute(db)
  await sql`
    ALTER TABLE multitable_automation_approval_bridges
    ADD CONSTRAINT chk_mt_auto_approval_bridge_claimable_has_approval
    CHECK (status NOT IN ('pending', 'resumed') OR approval_instance_id IS NOT NULL)
  `.execute(db)

  await replaceAutomationActionTypeConstraint(db, AUTOMATION_ACTION_TYPES_WITH_START_APPROVAL)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS multitable_automation_approval_bridges`.execute(db)
  await replaceAutomationActionTypeConstraint(db, AUTOMATION_ACTION_TYPES_BEFORE_START_APPROVAL)
}
