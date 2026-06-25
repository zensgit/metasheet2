import { sql, type Kysely } from 'kysely'

// T9-W-L1: a config-restore is forward-only — it appends a NEW meta_config_revisions row marked `source='restore'`
// with a back-reference (`restored_from_id`) to the revision it reverted, so a restore is distinguishable from an
// ordinary edit in the history and is itself inspectable. Existing rows + all current recording default to
// `source='mutation'`. This never rewrites prior rows.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE meta_config_revisions
      ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'mutation'
        CHECK (source IN ('mutation', 'restore')),
      ADD COLUMN IF NOT EXISTS restored_from_id uuid
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE meta_config_revisions DROP COLUMN IF EXISTS restored_from_id`.execute(db)
  await sql`ALTER TABLE meta_config_revisions DROP COLUMN IF EXISTS source`.execute(db)
}
