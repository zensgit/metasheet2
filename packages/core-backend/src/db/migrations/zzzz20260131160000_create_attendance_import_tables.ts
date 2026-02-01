import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { addColumnIfNotExists, checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const batchesExists = await checkTableExists(db, 'attendance_import_batches')
  if (!batchesExists) {
    await db.schema
      .createTable('attendance_import_batches')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', (col) => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('created_by', 'text')
      .addColumn('source', 'text')
      .addColumn('rule_set_id', 'uuid')
      .addColumn('mapping', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('row_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('committed'))
      .addColumn('meta', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_import_batches_org', 'attendance_import_batches', 'org_id')
  await createIndexIfNotExists(db, 'idx_attendance_import_batches_status', 'attendance_import_batches', ['org_id', 'status'])
  await createIndexIfNotExists(db, 'idx_attendance_import_batches_rule_set', 'attendance_import_batches', ['org_id', 'rule_set_id'])

  const itemsExists = await checkTableExists(db, 'attendance_import_items')
  if (!itemsExists) {
    await db.schema
      .createTable('attendance_import_items')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('batch_id', 'uuid', (col) =>
        col.notNull().references('attendance_import_batches.id').onDelete('cascade')
      )
      .addColumn('org_id', 'text', (col) => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('user_id', 'text')
      .addColumn('work_date', 'date')
      .addColumn('record_id', 'uuid')
      .addColumn('preview_snapshot', 'jsonb')
      .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_import_items_batch', 'attendance_import_items', 'batch_id')
  await createIndexIfNotExists(db, 'idx_attendance_import_items_org', 'attendance_import_items', ['org_id', 'batch_id'])

  await addColumnIfNotExists(db, 'attendance_records', 'source_batch_id', 'uuid')
  await createIndexIfNotExists(db, 'idx_attendance_records_source_batch', 'attendance_records', 'source_batch_id')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('attendance_import_items').ifExists().cascade().execute()
  await db.schema.dropTable('attendance_import_batches').ifExists().cascade().execute()
  await db.schema.alterTable('attendance_records').dropColumn('source_batch_id').execute()
}
