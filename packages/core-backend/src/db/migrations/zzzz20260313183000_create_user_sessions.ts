import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'user_sessions')
  if (!exists) {
    await db.schema
      .createTable('user_sessions')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('issued_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
      .addColumn('last_seen_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('revoked_at', 'timestamptz')
      .addColumn('revoked_by', 'text')
      .addColumn('revoke_reason', 'text')
      .addColumn('ip_address', 'text')
      .addColumn('user_agent', 'text')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_user_sessions_user_created_at', 'user_sessions', ['user_id', 'created_at'])
  await createIndexIfNotExists(db, 'idx_user_sessions_user_revoked_at', 'user_sessions', ['user_id', 'revoked_at'])
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('user_sessions').ifExists().cascade().execute()
}
