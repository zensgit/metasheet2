/**
 * W0-1 (corrected) §4 — generation-aware `HISTORY_INCOMPLETE` contiguity. Relaxes
 * `meta_record_revisions`'s `action` CHECK from the 3-value form (`create`/`update`/`delete`) to a
 * 5-value form adding `lock`/`unlock` — the two marker actions the same-txn lock/unlock write paths
 * (HTTP `univer-meta.ts` record lock route, automation `lock_record`) now emit alongside their existing
 * `version + 1` bump, so the version chain stays +1-dense across a lock/unlock exactly like any other
 * version-consuming step (content-neutral: `snapshot=NULL`, `patch='{}'`, `changed_field_ids=[]`).
 *
 * PURE RELAXATION — every existing row already satisfies `action IN ('create','update','delete')`, which
 * is a strict subset of the new 5-value set, so this validates instantly with no table rewrite and no
 * risk to existing data. `down()` restores the exact original 3-value CHECK (safe: no `lock`/`unlock` rows
 * exist until the marker-emission code ships, which lands in the SAME PR as this migration — never
 * before it, so a rollback of just this migration with the marker code still deployed would be the only
 * way to violate the restored 3-value CHECK, and that is a deploy-ordering concern for the rollback
 * operator, not this migration's job to prevent).
 *
 * NO UNIQUE CONSTRAINT OF ANY KIND — the owner's hard condition (§0.1): `generation` is DERIVED at query
 * time from the create-boundary window (see `history-integrity-precheck.ts`'s `checkGenerationContiguity`
 * §1), never stored, so there is nothing to key a unique index on. The supporting index below is a plain
 * (non-unique) BTREE covering the contiguity walk's window.
 *
 * MUST be a `zzzz`-timestamped Kysely migration, NOT a numeric-prefixed `.sql` file: `meta_record_revisions`
 * itself is created by `zzzz20260430172000_create_meta_record_revisions`, which sorts AFTER every 0xx SQL
 * migration — a numeric file would run before the table exists and silently no-op (the documented
 * `restored_from_version` pitfall). This file also sorts after `zzzz20260711000000` (the most recent prior
 * ALTER on this table), so both ordering constraints the design-lock calls out are satisfied.
 *
 * Verify with a fresh-DB full migrate (see the PR body for the proof run).
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE meta_record_revisions DROP CONSTRAINT IF EXISTS meta_record_revisions_action_check`.execute(db)
  await sql`ALTER TABLE meta_record_revisions ADD CONSTRAINT meta_record_revisions_action_check CHECK (action IN ('create', 'update', 'delete', 'lock', 'unlock'))`.execute(db)

  // Optional supporting index (recommended, §4) for the §2 contiguity window scan
  // (`WHERE sheet_id = $1 ... PARTITION BY record_id ORDER BY created_at, version, id`) — NOT unique.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_revisions_sheet_record_created_version_id
    ON meta_record_revisions(sheet_id, record_id, created_at, version, id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_record_revisions_sheet_record_created_version_id`.execute(db)
  await sql`ALTER TABLE meta_record_revisions DROP CONSTRAINT IF EXISTS meta_record_revisions_action_check`.execute(db)
  await sql`ALTER TABLE meta_record_revisions ADD CONSTRAINT meta_record_revisions_action_check CHECK (action IN ('create', 'update', 'delete'))`.execute(db)
}
