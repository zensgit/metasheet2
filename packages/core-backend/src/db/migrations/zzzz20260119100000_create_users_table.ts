import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'users')
  if (!exists) {
    await db.schema
      .createTable('users')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('email', 'text', (col) => col.notNull())
      .addColumn('name', 'text')
      .addColumn('password_hash', 'text', (col) => col.notNull())
      .addColumn('role', 'text', (col) => col.notNull().defaultTo('user'))
      .addColumn('permissions', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('avatar_url', 'text')
      .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
      .addColumn('is_admin', 'boolean', (col) => col.notNull().defaultTo(false))
      .addColumn('last_login_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_users_email', 'users', 'email', { unique: true })
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('users').ifExists().cascade().execute()
}
