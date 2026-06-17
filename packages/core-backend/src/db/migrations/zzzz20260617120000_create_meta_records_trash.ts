/**
 * Migration: #15 recycle bin — soft-delete landing table for deleted multitable records.
 *
 * Record DELETE is a hard delete from meta_records (record-service.deleteRecord). This table is the
 * recycle bin: on delete the row is copied here in the SAME transaction, so it can be listed + restored.
 *
 * Design (ARC #15, conservative defaults): a SEPARATE table (NOT a tombstone column on meta_records) so
 * every existing read path is untouched. Retention is DISABLED by default — rows live here until an
 * explicit purge; no automatic aging. Surrogate uuid PK + record_id column so a delete→restore→delete
 * cycle never collides on the original id; restore resolves the most-recent trash row per record_id.
 */

import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_records_trash (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      record_id text NOT NULL,
      sheet_id text NOT NULL,
      base_id text,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      original_version integer NOT NULL DEFAULT 1,
      created_by text,
      deleted_by text,
      -- Original meta_records timestamps, captured at delete so restore preserves them (NOT reset to
      -- restore-time) — keeps sort-by-created/audit order stable across a delete→restore cycle.
      original_created_at timestamptz,
      original_updated_at timestamptz,
      deleted_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  // Listing: deleted records per sheet, newest first.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_records_trash_sheet_deleted
    ON meta_records_trash(sheet_id, deleted_at DESC)
  `.execute(db)

  // Restore lookup by original record id.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_records_trash_record
    ON meta_records_trash(record_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS meta_records_trash`.execute(db)
}
