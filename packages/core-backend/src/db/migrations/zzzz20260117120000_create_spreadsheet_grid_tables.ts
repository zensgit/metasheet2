import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('sheets')
    .ifNotExists()
    .addColumn('id', 'text', col => col.primaryKey().defaultTo(sql`gen_random_uuid()::text`))
    .addColumn('spreadsheet_id', 'text', col => col.notNull().references('spreadsheets.id').onDelete('cascade'))
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('order_index', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('row_count', 'integer', col => col.notNull().defaultTo(1000))
    .addColumn('column_count', 'integer', col => col.notNull().defaultTo(26))
    .addColumn('frozen_rows', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('frozen_columns', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('hidden_rows', 'jsonb')
    .addColumn('hidden_columns', 'jsonb')
    .addColumn('row_heights', 'jsonb')
    .addColumn('column_widths', 'jsonb')
    .addColumn('config', 'jsonb')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('idx_sheets_spreadsheet')
    .ifNotExists()
    .on('sheets')
    .column('spreadsheet_id')
    .execute()

  await db.schema
    .createTable('cells')
    .ifNotExists()
    .addColumn('id', 'text', col => col.primaryKey().defaultTo(sql`gen_random_uuid()::text`))
    .addColumn('sheet_id', 'text', col => col.notNull().references('sheets.id').onDelete('cascade'))
    .addColumn('row_index', 'integer', col => col.notNull())
    .addColumn('column_index', 'integer', col => col.notNull())
    .addColumn('value', 'jsonb')
    .addColumn('data_type', 'text')
    .addColumn('formula', 'text')
    .addColumn('computed_value', 'jsonb')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('idx_cells_sheet')
    .ifNotExists()
    .on('cells')
    .column('sheet_id')
    .execute()

  await db.schema
    .createIndex('idx_cells_sheet_row_col')
    .ifNotExists()
    .on('cells')
    .columns(['sheet_id', 'row_index', 'column_index'])
    .unique()
    .execute()

  await db.schema
    .createTable('cell_versions')
    .ifNotExists()
    .addColumn('id', 'text', col => col.primaryKey().defaultTo(sql`gen_random_uuid()::text`))
    .addColumn('cell_id', 'text', col => col.notNull().references('cells.id').onDelete('cascade'))
    .addColumn('sheet_id', 'text', col => col.notNull().references('sheets.id').onDelete('cascade'))
    .addColumn('version_number', 'integer', col => col.notNull().defaultTo(1))
    .addColumn('value', 'jsonb')
    .addColumn('formula', 'text')
    .addColumn('format', 'jsonb')
    .addColumn('changed_by', 'text')
    .addColumn('change_type', 'text')
    .addColumn('change_summary', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('idx_cell_versions_cell')
    .ifNotExists()
    .on('cell_versions')
    .columns(['cell_id', 'version_number'])
    .execute()

  await db.schema
    .createTable('named_ranges')
    .ifNotExists()
    .addColumn('id', 'text', col => col.primaryKey().defaultTo(sql`gen_random_uuid()::text`))
    .addColumn('spreadsheet_id', 'text', col => col.notNull().references('spreadsheets.id').onDelete('cascade'))
    .addColumn('sheet_id', 'text', col => col.references('sheets.id').onDelete('set null'))
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('range', 'text', col => col.notNull())
    .addColumn('description', 'text')
    .addColumn('created_by', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('idx_named_ranges_spreadsheet')
    .ifNotExists()
    .on('named_ranges')
    .column('spreadsheet_id')
    .execute()

  await db.schema
    .createIndex('idx_named_ranges_unique')
    .ifNotExists()
    .on('named_ranges')
    .columns(['spreadsheet_id', 'name'])
    .unique()
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('named_ranges').ifExists().execute()
  await db.schema.dropTable('cell_versions').ifExists().execute()
  await db.schema.dropTable('cells').ifExists().execute()
  await db.schema.dropTable('sheets').ifExists().execute()
}
