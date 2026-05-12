import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'users')
  if (!exists) {
    return
  }

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'users')
  if (!exists) {
    return
  }

  await sql`
    ALTER TABLE users
    DROP COLUMN IF EXISTS must_change_password
  `.execute(db)
}
