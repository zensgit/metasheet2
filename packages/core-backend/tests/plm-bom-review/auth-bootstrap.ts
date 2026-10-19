import type { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { up as sessions } from '../../src/db/migrations/zzzz20260313183000_create_user_sessions'
import { up as admissions } from '../../src/db/migrations/zzzz20260411120000_create_user_namespace_admissions'
import { up as revocations } from '../../src/db/migrations/zzzz20260312170000_create_user_session_revocations'

// Extends the existing disposable BOM fixture only after its original user inserts.
// Authentication/session queries below use genuine PG rows and these production migrations.
export async function bootstrapPlmBomReviewAuthTestDb(
  pool: Pool,
): Promise<void> {
  await pool.query(`ALTER TABLE users
    ADD COLUMN email text,
    ADD COLUMN username text,
    ADD COLUMN mobile text,
    ADD COLUMN name text,
    ADD COLUMN password_hash text,
    ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
    UPDATE users SET name=id,email=id||'@synthetic.invalid';`)
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  await sessions(db)
  await revocations(db)
  await admissions(db)
}
