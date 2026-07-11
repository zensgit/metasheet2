import { sql, type Kysely } from 'kysely'

/**
 * 4c-2 forward tombstone-capture (design-lock 2026-07-07, #3809 + #3830 correction; owner-ratified 2026-07-08).
 *
 * Two append-only tables that let a FUTURE destructive multitable op (field delete, record hard-delete's
 * inbound edges) be undone at the value level. Mirrors `meta_records_trash`
 * (`zzzz20260617120000_create_meta_records_trash.ts`) design principles: separate tables (ZERO existing
 * hot-read path touched), surrogate uuid PK, original timestamps NOT reset, `isUndefinedTableError`
 * compatible (callers guard the SAME way meta_links/meta_records_trash already do), retention disabled by
 * default (wired later into meta-revision-retention.ts under the SAME knob, keep-days only).
 *
 * Forward-only (4d redline): these tables are populated ONLY going forward once
 * `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` is turned on. Data destroyed before the flag was ever enabled has
 * no tombstone and is not retroactively recoverable — no path may pretend otherwise (design-lock §0/C1).
 *
 * `field_id`/`record_id`/`sheet_id` are deliberately NOT foreign keys to meta_fields/meta_records/meta_sheets:
 * those rows are the very rows the destructive op is about to remove (or which a cascade already removed by
 * the time we'd try to reference them), so an FK here would either block the delete or auto-cascade-delete
 * the tombstone itself — defeating the point. `config_revision_id` / `source_revision_id` are causal anchors
 * (back-references into meta_config_revisions / meta_record_revisions) but are likewise left un-FK'd,
 * mirroring `meta_config_revisions.restored_from_id` (zzzz20260624200000) which is also a bare uuid.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_field_value_tombstones (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sheet_id text NOT NULL,
      field_id text NOT NULL,
      record_id text NOT NULL,
      value jsonb NOT NULL,
      reason text NOT NULL CHECK (reason IN ('field_delete', 'lossy_retype')),
      config_revision_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  // Rehydration lookup (R1): all tombstoned values for the field being undeleted, scoped to the specific
  // delete's own revision id (a field id can in principle be deleted+undeleted multiple times over its
  // life; scoping by config_revision_id picks exactly the vintage matching THIS undelete, not a stray
  // earlier or later capture set for the same field_id).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_field_value_tombstones_revision_field
    ON meta_field_value_tombstones(config_revision_id, field_id)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_field_value_tombstones_sheet_field
    ON meta_field_value_tombstones(sheet_id, field_id)
  `.execute(db)
  // Retention sweep (age-based, keep-days; no partition/"keep latest" concept applies here).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_field_value_tombstones_created_at
    ON meta_field_value_tombstones(created_at)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_link_tombstones (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sheet_id text NOT NULL,
      field_id text NOT NULL,
      record_id text NOT NULL,
      foreign_record_id text NOT NULL,
      reason text NOT NULL CHECK (reason IN ('field_delete', 'record_delete')),
      source_revision_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_link_tombstones_revision_field
    ON meta_link_tombstones(source_revision_id, field_id)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_link_tombstones_sheet_field
    ON meta_link_tombstones(sheet_id, field_id)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_link_tombstones_created_at
    ON meta_link_tombstones(created_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_link_tombstones_created_at`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_link_tombstones_sheet_field`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_link_tombstones_revision_field`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_link_tombstones`.execute(db)

  await sql`DROP INDEX IF EXISTS idx_meta_field_value_tombstones_created_at`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_field_value_tombstones_sheet_field`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_field_value_tombstones_revision_field`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_field_value_tombstones`.execute(db)
}
