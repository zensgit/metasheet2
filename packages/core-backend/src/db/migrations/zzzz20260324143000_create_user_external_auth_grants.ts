import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const exists = await checkTableExists(db, 'user_external_auth_grants')
  if (!exists) {
    await db.schema
      .createTable('user_external_auth_grants')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('provider', 'text', (col) => col.notNull())
      .addColumn('local_user_id', 'text', (col) => col.notNull())
      .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
      .addColumn('granted_by', 'text')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_external_auth_grants_provider_user
    ON user_external_auth_grants(provider, local_user_id)
  `.execute(db)
  await createIndexIfNotExists(
    db,
    'idx_user_external_auth_grants_local_user',
    'user_external_auth_grants',
    ['local_user_id'],
  )

  await sql`
    INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by, created_at, updated_at)
    SELECT
      'dingtalk',
      local_user_id,
      TRUE,
      MAX(bound_by),
      NOW(),
      NOW()
    FROM user_external_identities
    WHERE provider = 'dingtalk'
    GROUP BY local_user_id
    ON CONFLICT (provider, local_user_id) DO NOTHING
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('user_external_auth_grants').ifExists().cascade().execute()
}
