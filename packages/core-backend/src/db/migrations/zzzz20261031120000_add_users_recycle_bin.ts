import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

/**
 * User recycle bin.
 *
 * Soft-delete columns only. The users row is never dropped: attendance, audit,
 * and directory history keep their foreign keys. Purge anonymizes the row
 * (purged_at) instead of deleting it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'users')
  if (!exists) return

  await sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
      ADD COLUMN IF NOT EXISTS deleted_by text,
      ADD COLUMN IF NOT EXISTS purge_after timestamptz,
      ADD COLUMN IF NOT EXISTS purged_at timestamptz,
      ADD COLUMN IF NOT EXISTS purged_by text,
      ADD COLUMN IF NOT EXISTS active_before_delete boolean
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_users_recycle_due
    ON users (purge_after)
    WHERE deleted_at IS NOT NULL AND purged_at IS NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'users')
  if (!exists) return

  await sql`DROP INDEX IF EXISTS idx_users_recycle_due`.execute(db)
  await sql`
    ALTER TABLE users
      DROP COLUMN IF EXISTS active_before_delete,
      DROP COLUMN IF EXISTS purged_by,
      DROP COLUMN IF EXISTS purged_at,
      DROP COLUMN IF EXISTS purge_after,
      DROP COLUMN IF EXISTS deleted_by,
      DROP COLUMN IF EXISTS deleted_at
  `.execute(db)
}
