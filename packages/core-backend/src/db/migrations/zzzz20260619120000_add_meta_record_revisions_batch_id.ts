/**
 * Global History & Point-in-Time Restore — T1 foundation (per T0 decision D1).
 *
 * Adds `meta_record_revisions.batch_id text NULL` + an index. The batch_id is a deterministic grouping
 * key (LOCK-12: one user action = one batch) stamped at the single revision-write chokepoint
 * (`recordRecordRevision`): a single-record action defaults batch_id to the revision's own id (one
 * revision = one batch); a bulk action passes one shared batch_id across its rows. This is NOT a parallel
 * history store (LOCK-1) — it is a grouping column on the existing append-only revision log. Legacy rows
 * (batch_id NULL, pre-migration) are grouped by the read-side heuristic and marked provenanceQuality=legacy.
 *
 * Inert + non-breaking: nullable column, no behaviour change until the history projection reads it.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE meta_record_revisions ADD COLUMN IF NOT EXISTS batch_id text`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_meta_record_revisions_sheet_batch ON meta_record_revisions(sheet_id, batch_id)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_record_revisions_sheet_batch`.execute(db)
  await sql`ALTER TABLE meta_record_revisions DROP COLUMN IF EXISTS batch_id`.execute(db)
}
