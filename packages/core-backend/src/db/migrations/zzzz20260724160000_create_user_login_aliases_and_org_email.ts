import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

/**
 * T2a — login alias table + directory_accounts.org_email (design lock Rev 4.2 §4).
 *
 * - user_login_aliases.normalized_value is GLOBAL UNIQUE (not kind-scoped).
 * - Backfill only uncontested email/username/mobile into aliases; collisions go to report table.
 * - Auth read path is NOT switched here (T2b).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  if (await checkTableExists(db, 'directory_accounts')) {
    await sql`
      ALTER TABLE directory_accounts
      ADD COLUMN IF NOT EXISTS org_email text
    `.execute(db)
  }

  if (!(await checkTableExists(db, 'user_login_aliases'))) {
    await sql`
      CREATE TABLE user_login_aliases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN ('email', 'mobile', 'username')),
        normalized_value text NOT NULL,
        source text NOT NULL DEFAULT 'migration',
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT user_login_aliases_normalized_value_key UNIQUE (normalized_value)
      )
    `.execute(db)
    await sql`
      CREATE INDEX idx_user_login_aliases_user_id ON user_login_aliases (user_id)
    `.execute(db)
  }

  if (!(await checkTableExists(db, 'user_login_alias_collision_report'))) {
    await sql`
      CREATE TABLE user_login_alias_collision_report (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        normalized_value text NOT NULL,
        kind text NOT NULL,
        candidate_user_ids text[] NOT NULL,
        reason text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT NOW()
      )
    `.execute(db)
    await sql`
      CREATE INDEX idx_user_login_alias_collision_value
      ON user_login_alias_collision_report (normalized_value)
    `.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS user_login_alias_collision_report`.execute(db)
  await sql`DROP TABLE IF EXISTS user_login_aliases`.execute(db)
  if (await checkTableExists(db, 'directory_accounts')) {
    await sql`ALTER TABLE directory_accounts DROP COLUMN IF EXISTS org_email`.execute(db)
  }
}
