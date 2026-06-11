import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'
const TABLE = 'attendance_notification_deliveries'

// C5-0 (design-lock #2483). LATENT outbox schema only: no producer, worker, or channel
// writes this table yet. The table separates source intent from delivery truth so later
// C5 slices can retry per recipient/channel without treating source dispatched_at as
// external delivery success.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const exists = await checkTableExists(db, TABLE)
  if (!exists) {
    await db.schema
      .createTable(TABLE)
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('source_type', 'text', col => col.notNull())
      .addColumn('source_id', 'text')
      .addColumn('source_key', 'text', col => col.notNull())
      .addColumn('recipient_user_id', 'text', col => col.notNull())
      .addColumn('recipient_role', 'text', col => col.notNull())
      .addColumn('channel', 'text', col => col.notNull())
      .addColumn('status', 'text', col => col.notNull().defaultTo('pending'))
      .addColumn('attempt_count', 'integer', col => col.notNull().defaultTo(0))
      .addColumn('next_attempt_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .addColumn('last_attempt_at', 'timestamptz')
      .addColumn('claimed_at', 'timestamptz')
      .addColumn('claim_expires_at', 'timestamptz')
      .addColumn('claim_worker_id', 'text')
      .addColumn('delivered_at', 'timestamptz')
      .addColumn('last_error', 'text')
      .addColumn('payload', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .addCheckConstraint('chk_attendance_notification_deliveries_status', sql`status IN ('pending', 'sending', 'sent', 'retrying', 'failed', 'skipped')`)
      .addCheckConstraint('chk_attendance_notification_deliveries_attempt_count', sql`attempt_count >= 0`)
      .addCheckConstraint('chk_attendance_notification_deliveries_delivered_status', sql`delivered_at IS NULL OR status = 'sent'`)
      .execute()
  }

  await createIndexIfNotExists(db, 'uq_attendance_notification_deliveries_source_key', TABLE, ['org_id', 'source_key'], { unique: true })
  await createIndexIfNotExists(db, 'idx_attendance_notification_deliveries_claim', TABLE, ['status', 'next_attempt_at'])
  await createIndexIfNotExists(db, 'idx_attendance_notification_deliveries_reclaim', TABLE, ['status', 'claim_expires_at'])
  await createIndexIfNotExists(db, 'idx_attendance_notification_deliveries_source', TABLE, ['org_id', 'source_type', 'source_id'])
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable(TABLE).ifExists().execute()
}
