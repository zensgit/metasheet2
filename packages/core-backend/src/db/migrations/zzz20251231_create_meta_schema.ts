import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await db.schema
    .createTable('meta_sheets')
    .addColumn('id', 'text', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()::text`))
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('meta_fields')
    .addColumn('id', 'text', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()::text`))
    .addColumn('sheet_id', 'text', (col) => col.notNull().references('meta_sheets.id').onDelete('cascade'))
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('property', 'jsonb', (col) => col.defaultTo(sql`'{}'::jsonb`))
    .addColumn('order', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createTable('meta_views')
    .addColumn('id', 'text', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()::text`))
    .addColumn('sheet_id', 'text', (col) => col.notNull().references('meta_sheets.id').onDelete('cascade'))
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('filter_info', 'jsonb', (col) => col.defaultTo(sql`'{}'::jsonb`))
    .addColumn('sort_info', 'jsonb', (col) => col.defaultTo(sql`'{}'::jsonb`))
    .addColumn('group_info', 'jsonb', (col) => col.defaultTo(sql`'{}'::jsonb`))
    .addColumn('hidden_field_ids', 'jsonb', (col) => col.defaultTo(sql`'[]'::jsonb`))
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createTable('meta_records')
    .addColumn('id', 'text', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()::text`))
    .addColumn('sheet_id', 'text', (col) => col.notNull().references('meta_sheets.id').onDelete('cascade'))
    .addColumn('data', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createTable('meta_links')
    .addColumn('id', 'text', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()::text`))
    .addColumn('field_id', 'text', (col) => col.notNull().references('meta_fields.id').onDelete('cascade'))
    .addColumn('record_id', 'text', (col) => col.notNull().references('meta_records.id').onDelete('cascade'))
    .addColumn('foreign_record_id', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .execute()

  await sql`CREATE INDEX idx_meta_fields_sheet ON meta_fields(sheet_id)`.execute(db)
  await sql`CREATE INDEX idx_meta_fields_sheet_order ON meta_fields(sheet_id, "order")`.execute(db)
  await sql`CREATE INDEX idx_meta_views_sheet ON meta_views(sheet_id)`.execute(db)
  await sql`CREATE INDEX idx_meta_records_sheet ON meta_records(sheet_id)`.execute(db)
  await sql`CREATE INDEX idx_meta_records_created ON meta_records(sheet_id, created_at)`.execute(db)
  await sql`CREATE INDEX idx_meta_links_field ON meta_links(field_id)`.execute(db)
  await sql`CREATE INDEX idx_meta_links_record ON meta_links(record_id)`.execute(db)
  await sql`CREATE INDEX idx_meta_links_foreign ON meta_links(foreign_record_id)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('meta_links').execute()
  await db.schema.dropTable('meta_records').execute()
  await db.schema.dropTable('meta_views').execute()
  await db.schema.dropTable('meta_fields').execute()
  await db.schema.dropTable('meta_sheets').execute()
}
