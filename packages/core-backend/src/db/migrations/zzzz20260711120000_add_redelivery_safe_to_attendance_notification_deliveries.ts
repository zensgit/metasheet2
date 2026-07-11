/**
 * Migration: `redelivery_safe` flag on attendance_notification_deliveries (PR #4102 owner
 * CHANGES-REQUESTED, §7.6 delivery closure).
 *
 * Why this column exists — the owner-caught bug: `status='failed'` alone does NOT prove a row is
 * safe for OPERATOR-initiated redelivery. attendance_notification_deliveries is a MULTI-CHANNEL
 * shared outbox (dingtalk_work_notification / wecom_work_notification / email_smtp). Two classes of
 * `failed` row are duplicate-notification hazards if resent:
 *   - Pre-#4046 DingTalk timeouts/5xx (ambiguous sends recorded as `failed` before the
 *     `outcome_unknown` vocabulary existed) — may already have been delivered.
 *   - WeCom / Email failures — those channels never emit the `outcome_unknown` marker, so a `failed`
 *     row there can also be an ambiguous send.
 * A boolean the worker sets ONLY on a definite, non-ambiguous DingTalk non-delivery (markFailed,
 * which per the deliver() invariant is only ever reached by a definite failure — ambiguous results
 * go to markOutcomeUnknown) is the load-bearing signal the redelivery gate keys on.
 *
 * up(): ADD COLUMN redelivery_safe boolean NOT NULL DEFAULT false. All pre-existing rows become
 * `false`, which is correct by design — every historical `failed` row (multi-channel, pre-flag) is
 * NOT eligible for redelivery. On PostgreSQL 11+ `ADD COLUMN ... NOT NULL DEFAULT <constant>` is a
 * metadata-only change (catalog default, no table rewrite / full-table lock), so this is cheap even
 * on a large outbox.
 *
 * Guarded by checkTableExists so partial-schema test harnesses (isolated-schema suites that run only
 * the migrations they need) can apply this migration too, mirroring the sibling
 * zzzz20260710150000_add_outcome_unknown_delivery_status. down(): DROP COLUMN.
 */
import { sql, type Kysely } from 'kysely'
import { checkTableExists } from './_patterns'

const TABLE = 'attendance_notification_deliveries'

export async function up(db: Kysely<unknown>): Promise<void> {
  if (await checkTableExists(db, TABLE)) {
    // IF NOT EXISTS keeps the migration idempotent under allowUnorderedMigrations replay. NOT NULL
    // DEFAULT false is metadata-only on PG 11+ (no rewrite): existing rows read the catalog default.
    await sql`
      ALTER TABLE attendance_notification_deliveries
      ADD COLUMN IF NOT EXISTS redelivery_safe boolean NOT NULL DEFAULT false
    `.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (await checkTableExists(db, TABLE)) {
    await sql`
      ALTER TABLE attendance_notification_deliveries
      DROP COLUMN IF EXISTS redelivery_safe
    `.execute(db)
  }
}
