import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'user_session_revocations')
  if (!exists) {
    await db.schema
      .createTable('user_session_revocations')
      .addColumn('user_id', 'text', (col) => col.primaryKey())
      .addColumn('revoked_after', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_by', 'text')
      .addColumn('reason', 'text')
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_user_session_revocations_updated_by', 'user_session_revocations', 'updated_by')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('user_session_revocations').ifExists().cascade().execute()
}
