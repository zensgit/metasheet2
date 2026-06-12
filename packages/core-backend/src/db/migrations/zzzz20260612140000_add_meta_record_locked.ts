import { sql, type Kysely } from 'kysely'

/**
 * Record locking storage (design #2278 follow-up — lock_record storage contract).
 *
 * `executeLockRecord` historically UPDATEd a non-existent `meta_records.locked` column,
 * so the automation crashed at runtime (#2278 only hid the action from the rule-editor
 * dropdown). This adds the three backing columns so the action — plus the manual
 * lock/unlock write-path guard — has a real store.
 *
 * Decision a = whole-record lock (no per-field granularity).
 * Decision c = ONE shared column set for both manual and automation locks.
 * Existing rows default to `locked = false` (NOT NULL DEFAULT false).
 *
 * `locked_by` carries the locking actor id (or 'system' for an actor-less automation run)
 * and is indexed mirroring the `modified_by` precedent
 * (zzzz20260430163000_add_meta_record_modified_by.ts).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE meta_records ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false`.execute(db)
  await sql`ALTER TABLE meta_records ADD COLUMN IF NOT EXISTS locked_by text`.execute(db)
  await sql`ALTER TABLE meta_records ADD COLUMN IF NOT EXISTS locked_at timestamptz`.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_records_locked_by
    ON meta_records(locked_by)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_records_locked_by`.execute(db)
  await sql`ALTER TABLE meta_records DROP COLUMN IF EXISTS locked_at`.execute(db)
  await sql`ALTER TABLE meta_records DROP COLUMN IF EXISTS locked_by`.execute(db)
  await sql`ALTER TABLE meta_records DROP COLUMN IF EXISTS locked`.execute(db)
}
