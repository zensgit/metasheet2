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

  await sql`
    CREATE INDEX IF NOT EXISTS users_email_lower_idx
    ON users (lower(email))
    WHERE email IS NOT NULL
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS users_mobile_nospace_idx
    ON users (regexp_replace(mobile, '\\s+', '', 'g'))
    WHERE mobile IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE users
    SET email = COALESCE(email, id || '@migration-revert.local')
    WHERE email IS NULL
  `.execute(db)

  await sql`
    DROP INDEX IF EXISTS users_mobile_nospace_idx
  `.execute(db)

  await sql`
    DROP INDEX IF EXISTS users_email_lower_idx
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
