/**
 * Migration: `multitable_webhooks.sheet_id` — each subscription webhook is bound to one sheet.
 *
 * A subscription webhook receives record events only for the sheet it is bound to, and only what its owner
 * can currently read on that sheet. The binding is set when the webhook is created (or, for a row created
 * before this column existed, by binding it once from the sheet it should follow) and cannot be changed
 * afterwards. A row with a NULL binding receives no events.
 *
 * Additive and nullable: existing rows keep NULL and are not otherwise modified (their `active` flag is left
 * as it is). The partial index serves the delivery candidate lookup `active = true AND sheet_id = $1`.
 *
 * `multitable_webhooks` is created by the `zzzz20260414100002` migration, so this change must also be a
 * `zzzz` migration to sort after it.
 *
 * Down drops only the index and keeps the column: the delivery code reads `sheet_id`, and bindings owners
 * already made are kept for when the code is deployed again.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE multitable_webhooks ADD COLUMN IF NOT EXISTS sheet_id text`.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_multitable_webhooks_sheet_active
      ON multitable_webhooks (sheet_id)
      WHERE active = true
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_multitable_webhooks_sheet_active`.execute(db)
}
