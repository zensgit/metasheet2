import { sql, type Kysely } from 'kysely'

/**
 * 4c-3 record-undelete inbound-edge replay (design-lock 2026-07-08, owner-ratified 2026-07-09,
 * Option A) — the ANCHOR column that unblocks the replay.
 *
 * `deleteRecord` pre-generates its delete revision's id and uses it as the inbound-link tombstones'
 * `source_revision_id` — but `meta_records_trash` never recorded that id, so a restore driven by the
 * trash row could not NAME its tombstones' anchor. This adds the missing back-reference.
 *
 * Forward-only, nullable, NO backfill (design-lock §2): rows written before this migration have
 * `delete_revision_id IS NULL`, which restore treats as "no inbound replay" +
 * `inboundEdgesRecoverable=false` — honestly, never via heuristics. A
 * `(sheet_id, record_id, action='delete') ORDER BY created_at DESC` style backfill is FORBIDDEN:
 * under delete→restore→delete cycles it silently anchors to the WRONG vintage, and when the last
 * delete came from a path without capture it anchors to a revision that has no tombstones at all.
 *
 * Bare uuid-as-text back-reference, deliberately un-FK'd — mirrors `source_revision_id` on the
 * tombstone tables (zzzz20260708090000) and `meta_config_revisions.restored_from_id`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE meta_records_trash
      ADD COLUMN IF NOT EXISTS delete_revision_id text
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE meta_records_trash
      DROP COLUMN IF EXISTS delete_revision_id
  `.execute(db)
}
