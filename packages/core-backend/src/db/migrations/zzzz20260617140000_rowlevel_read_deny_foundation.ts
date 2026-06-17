/**
 * Migration: #18 row-level record read-deny — FOUNDATION ONLY (inert until the enforcement slice).
 *
 * Adds the building blocks WITHOUT enforcing anything:
 *  - `access_level='none'` (a read-deny grant) to the record_permissions CHECK constraint;
 *  - `meta_sheets.row_level_read_permissions_enabled` boolean, DEFAULT false (the per-sheet opt-in).
 *
 * NON-BREAKING + zero partial-deny risk: no read path consults the flag yet, deriveRecordPermissions
 * only denies 'none' when explicitly told the flag is on (no caller passes it), and the per-record
 * write API still restricts access_level to read/write/admin — so 'none' cannot even be SET yet. With
 * the flag off everywhere, behavior is byte-identical to today and the #2754 grant-additive canary
 * stays green. The read-path enforcement (CTE on every surface) + write-API-allow-'none' + conflict
 * semantics + golden suite are the next (XL) slice and MUST land before any sheet enables the flag.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE record_permissions DROP CONSTRAINT IF EXISTS record_permissions_access_level_check`.execute(db)
  await sql`
    ALTER TABLE record_permissions
    ADD CONSTRAINT record_permissions_access_level_check
    CHECK (access_level IN ('read', 'write', 'admin', 'none'))
  `.execute(db)
  await sql`ALTER TABLE meta_sheets ADD COLUMN IF NOT EXISTS row_level_read_permissions_enabled boolean NOT NULL DEFAULT false`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE meta_sheets DROP COLUMN IF EXISTS row_level_read_permissions_enabled`.execute(db)
  // 'none' rows would violate the narrowed constraint — remove them before re-adding it.
  await sql`DELETE FROM record_permissions WHERE access_level = 'none'`.execute(db)
  await sql`ALTER TABLE record_permissions DROP CONSTRAINT IF EXISTS record_permissions_access_level_check`.execute(db)
  await sql`
    ALTER TABLE record_permissions
    ADD CONSTRAINT record_permissions_access_level_check
    CHECK (access_level IN ('read', 'write', 'admin'))
  `.execute(db)
}
