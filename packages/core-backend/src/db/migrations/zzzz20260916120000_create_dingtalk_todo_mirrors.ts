/**
 * Migration: DingTalk approval-todo ONE-WAY mirror ledger (plan B).
 *
 * Design: docs/development/takeover-beiliao-20260821/dingtalk-todo-mirror-b-design-20260916.md §3.
 * Tables: dingtalk_todo_mirrors (new). Breaking: No — new table only, and the whole runtime that
 * reads/writes it is gated by DINGTALK_TODO_MIRROR_ENABLED (default OFF), so this ships LATENT.
 *
 * THE LOAD-BEARING INDEX
 *   `uq_dingtalk_todo_mirrors_source_key` — UNIQUE (org_id, source_key), where source_key IS the
 *   `approval.task_created` eventId (`approval-task:<instanceId>:<nodeKey>:<epoch>:<assignee>`). It is
 *   the IDEMPOTENCY key for a durable consumer that is redelivered at-least-once: the consumer's
 *   INSERT ... ON CONFLICT (org_id, source_key) DO NOTHING turns a duplicate delivery into a no-op
 *   instead of a SECOND DingTalk todo for the same pending task. Drop the constraint (or the ON
 *   CONFLICT target) and a redelivery creates a duplicate todo — pinned by the consumer's
 *   duplicate-event test. Same shape as `uq_attendance_notification_deliveries_source_key`.
 *
 * The other three indexes serve the worker: the due-claim scan (status, next_attempt_at), the
 * lease-expiry reclaim scan (status, claim_expires_at), and the consumer's per-instance supersede /
 * terminal sweep (instance_id, status).
 *
 * `org_id` is NOT NULL with no default: it is re-read from `approval_instances.org_id` by the consumer
 * (the event payload carries none) and a NULL there means the row is NEVER created (`skipped_no_org`) —
 * a DB default would silently file another tenant's task under 'default'.
 *
 * Idempotent: information_schema guard around CREATE TABLE, every index IF NOT EXISTS, constraints
 * DROP-then-ADD (the zzzz20260915120000 record-approval migration's shape).
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

export const DINGTALK_TODO_MIRRORS_TABLE = 'dingtalk_todo_mirrors'

/** The exact status vocabulary the CHECK constraint allows (mirrored in the service/worker). */
export const DINGTALK_TODO_MIRROR_STATUSES = [
  'pending',
  'sending',
  'created',
  'completing',
  'completed',
  'superseded',
  'failed',
  'skipped',
  'outcome_unknown',
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const exists = await checkTableExists(db, DINGTALK_TODO_MIRRORS_TABLE)
  if (!exists) {
    await sql`
      CREATE TABLE IF NOT EXISTS dingtalk_todo_mirrors (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        request_no TEXT,
        template_id TEXT,
        node_key TEXT NOT NULL,
        entry_epoch INTEGER,
        recipient_user_id TEXT NOT NULL,
        recipient_union_id TEXT,
        integration_id uuid,
        source_key TEXT NOT NULL,
        dingtalk_task_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        complete_reason TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_attempt_at TIMESTAMPTZ,
        claimed_at TIMESTAMPTZ,
        claim_expires_at TIMESTAMPTZ,
        claim_worker_id TEXT,
        last_error TEXT,
        redelivery_safe BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db)
  }

  // §3 index 1 — THE idempotency key (see header). UNIQUE (org_id, source_key).
  await createIndexIfNotExists(db, 'uq_dingtalk_todo_mirrors_source_key', DINGTALK_TODO_MIRRORS_TABLE, ['org_id', 'source_key'], { unique: true })
  // §3 index 2/3 — the worker's due-claim and lease-reclaim scans.
  await createIndexIfNotExists(db, 'idx_dingtalk_todo_mirrors_claim', DINGTALK_TODO_MIRRORS_TABLE, ['status', 'next_attempt_at'])
  await createIndexIfNotExists(db, 'idx_dingtalk_todo_mirrors_reclaim', DINGTALK_TODO_MIRRORS_TABLE, ['status', 'claim_expires_at'])
  // §3 index 4 — the consumer's per-instance supersede / terminal sweep.
  await createIndexIfNotExists(db, 'idx_dingtalk_todo_mirrors_instance', DINGTALK_TODO_MIRRORS_TABLE, ['instance_id', 'status'])

  await sql`
    ALTER TABLE dingtalk_todo_mirrors
    DROP CONSTRAINT IF EXISTS chk_dingtalk_todo_mirrors_status
  `.execute(db)
  await sql`
    ALTER TABLE dingtalk_todo_mirrors
    ADD CONSTRAINT chk_dingtalk_todo_mirrors_status
    CHECK (status IN ('pending', 'sending', 'created', 'completing', 'completed', 'superseded', 'failed', 'skipped', 'outcome_unknown'))
  `.execute(db)
  await sql`
    ALTER TABLE dingtalk_todo_mirrors
    DROP CONSTRAINT IF EXISTS chk_dingtalk_todo_mirrors_attempt_count
  `.execute(db)
  await sql`
    ALTER TABLE dingtalk_todo_mirrors
    ADD CONSTRAINT chk_dingtalk_todo_mirrors_attempt_count
    CHECK (attempt_count >= 0)
  `.execute(db)
  await sql`
    ALTER TABLE dingtalk_todo_mirrors
    DROP CONSTRAINT IF EXISTS chk_dingtalk_todo_mirrors_complete_reason
  `.execute(db)
  await sql`
    ALTER TABLE dingtalk_todo_mirrors
    ADD CONSTRAINT chk_dingtalk_todo_mirrors_complete_reason
    CHECK (complete_reason IS NULL OR complete_reason IN ('next_node', 'approved', 'rejected', 'revoked', 'cancelled'))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_dingtalk_todo_mirrors_instance`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_dingtalk_todo_mirrors_reclaim`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_dingtalk_todo_mirrors_claim`.execute(db)
  await sql`DROP INDEX IF EXISTS uq_dingtalk_todo_mirrors_source_key`.execute(db)
  await sql`DROP TABLE IF EXISTS dingtalk_todo_mirrors`.execute(db)
}
