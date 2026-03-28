import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const exists = await checkTableExists(db, 'user_invites')
  if (!exists) {
    await db.schema
      .createTable('user_invites')
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('email', 'varchar(255)', (col) => col.notNull())
      .addColumn('preset_id', 'varchar(128)')
      .addColumn('product_mode', 'varchar(32)', (col) => col.notNull().defaultTo('platform'))
      .addColumn('role_id', 'varchar(128)')
      .addColumn('invited_by', 'text')
      .addColumn('invite_token', 'text', (col) => col.notNull())
      .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('pending'))
      .addColumn('accepted_at', 'timestamptz')
      .addColumn('consumed_by', 'text')
      .addColumn('last_sent_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_user_invites_user_id', 'user_invites', 'user_id')
  await createIndexIfNotExists(db, 'idx_user_invites_status_created_at', 'user_invites', ['status', 'created_at'])
  await createIndexIfNotExists(db, 'idx_user_invites_email_created_at', 'user_invites', ['email', 'created_at'])
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('user_invites').ifExists().cascade().execute()
}
