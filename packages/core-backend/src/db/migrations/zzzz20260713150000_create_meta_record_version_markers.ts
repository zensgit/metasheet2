import { sql, type Kysely } from 'kysely'

/**
 * W0-1 (OD-W0-1 = marker mechanism (b), owner §6.1) — the independent version-marker table.
 *
 * The four lock/unlock sites (HTTP `univer-meta.ts` lock/unlock, automation `automation-executor.ts`
 * lock/unlock) legally do `version = version + 1` WITHOUT writing a revision: they are metadata-only
 * bumps, not data writes. The generation-aware contiguity precheck (`history-integrity-precheck.ts`)
 * would otherwise read that version as a HOLE (an uncaptured data write) and false-refuse a healthy
 * locked record. This table records "this version bump was a lock/unlock, not a data write" OUT of the
 * revision chain.
 *
 * Mechanism (b) is chosen over (a) lightweight lock/unlock revisions precisely to AVOID the C7 ripple:
 * `meta_record_revisions.action CHECK (action IN ('create','update','delete'))` stays closed, and the
 * History UI / retention / reconstructor never see a new action vocabulary. This table is read ONLY by
 * the contiguity precheck.
 *
 * `UNIQUE (sheet_id, record_id, version)` is the C5 fail-closed constraint FOR MARKERS: exactly one
 * marker per version, so a conflicting/duplicate marker cannot be forged. (The revisions table itself
 * CANNOT carry `UNIQUE (sheet_id, record_id, version)` — a delete revision legally REUSES the last live
 * version — so the create/update exact-set is enforced in application code; markers, being a brand-new
 * table with no reuse semantics, get the DB constraint for free.)
 *
 * zzzz-timestamped ([[feedback_migration_zzzz_ordering]]): this table shares the version-space of
 * `meta_records` / `meta_record_revisions`, both of which are created in zzzz migrations. Proven on a
 * FRESH-DB full migrate (not a preloaded DB) per the migration discipline.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_record_version_markers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sheet_id text NOT NULL,
      record_id text NOT NULL,
      version integer NOT NULL,
      kind text NOT NULL CHECK (kind IN ('lock', 'unlock')),
      actor_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_meta_record_version_markers_sheet_record_version UNIQUE (sheet_id, record_id, version)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_version_markers_sheet_record
    ON meta_record_version_markers(sheet_id, record_id, version)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_record_version_markers_sheet_record`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_record_version_markers`.execute(db)
}
