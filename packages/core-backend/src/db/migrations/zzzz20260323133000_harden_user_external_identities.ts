import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { addForeignKeyIfNotExists, checkTableExists, createIndexIfNotExists, dropIndexIfExists } from './_patterns'

const UNIQUE_INDEX = 'uq_user_external_identities_local_user_provider'
const FK_NAME = 'fk_user_external_identities_local_user'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'user_external_identities')
  if (!exists) return

  await sql`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY provider, local_user_id
          ORDER BY updated_at DESC, created_at DESC, id DESC
        ) AS rn
      FROM user_external_identities
    )
    DELETE FROM user_external_identities target
    USING ranked
    WHERE target.id = ranked.id
      AND ranked.rn > 1
  `.execute(db)

  await addForeignKeyIfNotExists(
    db,
    FK_NAME,
    'user_external_identities',
    'local_user_id',
    'users',
    'id',
    {
      onDelete: 'cascade',
      onUpdate: 'cascade',
    },
  )

  await createIndexIfNotExists(
    db,
    UNIQUE_INDEX,
    'user_external_identities',
    ['local_user_id', 'provider'],
    { unique: true },
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await dropIndexIfExists(db, UNIQUE_INDEX)
  await sql`ALTER TABLE user_external_identities DROP CONSTRAINT IF EXISTS ${sql.id(FK_NAME)}`.execute(db)
}
