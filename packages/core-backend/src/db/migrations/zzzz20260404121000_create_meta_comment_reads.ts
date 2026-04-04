import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_comment_reads (
      comment_id text NOT NULL,
      user_id text NOT NULL,
      read_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (comment_id, user_id)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_comment_reads_user
    ON meta_comment_reads(user_id, read_at DESC)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_comment_reads_comment
    ON meta_comment_reads(comment_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_comment_reads_comment`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_comment_reads_user`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_comment_reads`.execute(db)
}
