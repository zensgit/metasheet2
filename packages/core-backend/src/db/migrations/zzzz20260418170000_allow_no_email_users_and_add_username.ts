import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE users
    ALTER COLUMN email DROP NOT NULL
  `.execute(db)

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS username TEXT
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique_idx
    ON users (lower(username))
    WHERE username IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE users
    SET email = COALESCE(email, id || '@migration-revert.local')
    WHERE email IS NULL
  `.execute(db)

  await sql`
    DROP INDEX IF EXISTS users_username_lower_unique_idx
  `.execute(db)

  await sql`
    ALTER TABLE users
    DROP COLUMN IF EXISTS username
  `.execute(db)

  await sql`
    ALTER TABLE users
    ALTER COLUMN email SET NOT NULL
  `.execute(db)
}
