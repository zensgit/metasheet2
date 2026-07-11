/**
 * Migration: task_id trace index on the approval-card ledger (roadmap §7.6 "Delivery Closure" —
 * "Promote DingTalk task_id into queryable columns / operators can trace accepted async messages").
 *
 * `dingtalk_approval_card_deliveries.task_id` already EXISTS (created inline by
 * zzzz20260705120000_create_dingtalk_approval_card_deliveries and populated on a successful
 * asyncsend_v2 by markDingTalkApprovalCardDeliverySent). It was never queryable: no index, and no
 * lookup accessor. This migration adds ONLY the missing index — NOT a redundant column — so an
 * operator holding a DingTalk task_id can look up "was this async approval-card message accepted,
 * and under what instance/recipient" through findDingTalkApprovalCardDeliveriesByTaskId without a
 * sequential scan.
 *
 * Partial index (WHERE task_id IS NOT NULL): task_id is NULL for pending/failed rows that never
 * produced an accepted async send; those are never a trace target, and excluding them keeps the
 * index small. checkTableExists guards partial-schema test harnesses that apply only a subset of
 * migrations.
 */
import { sql, type Kysely } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, 'dingtalk_approval_card_deliveries'))) return
  await sql`
    CREATE INDEX IF NOT EXISTS idx_dacd_task_id
    ON dingtalk_approval_card_deliveries(task_id)
    WHERE task_id IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_dacd_task_id`.execute(db)
}
