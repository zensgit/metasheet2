import { sql, type Kysely } from 'kysely'

/**
 * A6-3-3 branch-local wait: store a structured resume cursor on a suspension row.
 *
 * A6-2 top-level waits resume by `step_index` alone. A6-3-3 branch-local waits
 * need a structured cursor (parent step index + selected branch key + branch
 * action index + step key + job ids + branch action fingerprint) so an admin
 * resume re-enters the SELECTED `condition_branch` at the right position.
 *
 * Nullable, no default: every existing A6-2 suspension keeps the legacy top-level
 * meaning (`parseResumeCursor`: NULL -> top_level). A non-null but malformed value
 * fails closed at resume (never a silent top-level `step_index` fallback). The
 * cursor is non-secret (types/ids only), so it is stored unredacted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE multitable_automation_suspensions ADD COLUMN IF NOT EXISTS resume_cursor jsonb`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE multitable_automation_suspensions DROP COLUMN IF EXISTS resume_cursor`.execute(db)
}
