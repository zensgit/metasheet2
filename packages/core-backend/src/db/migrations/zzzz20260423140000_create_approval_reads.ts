import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Wave 2 WP3 slice 2 (审批已读/未读): persistent per-user read state so the
 * 待办 tab can render an accurate "未读" badge and the detail view can silently
 * record first-open events. FK-cascade mirrors the other approval-scoped
 * tables so purging a cancelled instance also clears the read state.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS approval_reads (
      user_id TEXT NOT NULL,
      instance_id TEXT NOT NULL REFERENCES approval_instances(id) ON DELETE CASCADE,
      read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, instance_id)
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_reads_user_read_at
      ON approval_reads(user_id, read_at DESC)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_approval_reads_user_read_at`.execute(db)
  await sql`DROP TABLE IF EXISTS approval_reads`.execute(db)
}
