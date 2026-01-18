import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('spreadsheets')
    .ifNotExists()
    .addColumn('id', 'text', col => col.primaryKey())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('owner_id', 'text')
    .addColumn('deleted_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('idx_spreadsheets_deleted')
    .ifNotExists()
    .on('spreadsheets')
    .column('deleted_at')
    .execute()

  await db.schema
    .createIndex('idx_spreadsheets_owner')
    .ifNotExists()
    .on('spreadsheets')
    .column('owner_id')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('spreadsheets').ifExists().execute()
}
