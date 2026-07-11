/**
 * R11 restore back-reference (OD-0=(a)). Adds `meta_record_revisions.restored_from_version int NULL`.
 *
 * Records which SOURCE record-version a `source='restore'` record-version restore wrote from, so the
 * History Center can render "restored from version N". Forward-only, NO backfill (legacy rows stay NULL —
 * not inferred). Only the three record-version restore routes (record-restore-execute,
 * restore-batch-execute, legacy /restore) populate it; every other write — including the non-version-restore
 * `source='restore'` emitters (PIT-resurrect, PIT-reset, lossy-retype-revert) — leaves it NULL by design.
 * The FE badge keys on NON-NULL, never on `source='restore'`.
 *
 * MUST be a `zzzz`-timestamped Kysely migration (like batch_id), NOT a numeric-prefixed SQL file: the
 * `meta_record_revisions` table itself is created by zzzz20260430172000_create_meta_record_revisions, which
 * sorts AFTER every 0xx SQL migration. A numeric 067_*.sql ran BEFORE the table existed and silently no-op'd
 * (its to_regclass guard saw no table) — the column was never added, breaking the realdb goldens on a
 * from-scratch migrate. This file sorts after the table creation + batch_id, so the ALTER always lands.
 *
 * Inert + non-breaking: nullable column, no behaviour change until a restore write populates it.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE meta_record_revisions ADD COLUMN IF NOT EXISTS restored_from_version int`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE meta_record_revisions DROP COLUMN IF EXISTS restored_from_version`.execute(db)
}
