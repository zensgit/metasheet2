import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import type { Database } from '../types'

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('system_configs')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('key', 'text', (col) => col.notNull())
    .addColumn('value', 'text', (col) => col.notNull())
    .addColumn('is_encrypted', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('description', 'text')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createIndex('system_configs_key_unique')
    .on('system_configs')
    .column('key')
    .unique()
    .ifNotExists()
    .execute()
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('system_configs').ifExists().execute()
}
