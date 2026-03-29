import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const exists = await checkTableExists(db, 'user_external_identities')
  if (!exists) {
    await db.schema
      .createTable('user_external_identities')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('provider', 'text', (col) => col.notNull())
      .addColumn('external_key', 'text', (col) => col.notNull())
      .addColumn('provider_user_id', 'text')
      .addColumn('provider_union_id', 'text')
      .addColumn('provider_open_id', 'text')
      .addColumn('corp_id', 'text')
      .addColumn('local_user_id', 'text', (col) => col.notNull())
      .addColumn('profile', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('bound_by', 'text')
      .addColumn('last_login_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_external_identities_provider_key
    ON user_external_identities(provider, external_key)
  `.execute(db)
  await createIndexIfNotExists(
    db,
    'idx_user_external_identities_local_user',
    'user_external_identities',
    ['local_user_id', 'provider'],
  )
  await createIndexIfNotExists(
    db,
    'idx_user_external_identities_corp_provider',
    'user_external_identities',
    ['corp_id', 'provider'],
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('user_external_identities').ifExists().cascade().execute()
}
