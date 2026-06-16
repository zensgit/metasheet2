import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// B6-a: per-user-per-emoji comment reactions. Mirrors meta_comment_reads
// (composite PK, timestamptz, no surrogate id, NO foreign key — the comments
// sub-domain enforces cascade at the application layer in CommentService).
// The (comment_id, user_id, emoji) primary key makes "add reaction" idempotent
// (INSERT ... ON CONFLICT DO NOTHING) and lets a user attach several distinct
// emojis to one comment. The emoji palette is validated by a code-level
// allowlist in CommentService, NOT a DB CHECK constraint (an emoji is a display
// token, not a protocol enum — see design-lock B6-S0 §3.2).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_comment_reactions (
      comment_id text NOT NULL,
      user_id text NOT NULL,
      emoji text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (comment_id, user_id, emoji)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_comment_reactions_comment
    ON meta_comment_reactions(comment_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_comment_reactions_comment`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_comment_reactions`.execute(db)
}
