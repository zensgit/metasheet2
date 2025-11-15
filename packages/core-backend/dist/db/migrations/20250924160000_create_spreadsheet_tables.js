"use strict";
/**
 * Create spreadsheet core tables
 * Including spreadsheets, sheets, cells, formulas
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.up = up;
exports.down = down;
const kysely_1 = require("kysely");
async function up(db) {
    // Ensure pgcrypto for gen_random_uuid()
    await (0, kysely_1.sql) `CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);
    // Create spreadsheets table
    await db.schema
        .createTable('spreadsheets')
        .ifNotExists()
        .addColumn('id', 'uuid', col => col.primaryKey().defaultTo((0, kysely_1.sql) `gen_random_uuid()`))
        .addColumn('name', 'varchar(255)', col => col.notNull())
        .addColumn('description', 'text')
        .addColumn('owner_id', 'uuid')
        .addColumn('workspace_id', 'uuid')
        .addColumn('is_template', 'boolean', col => col.defaultTo(false))
        .addColumn('template_id', 'uuid')
        .addColumn('settings', 'jsonb', col => col.defaultTo((0, kysely_1.sql) `'{}'::jsonb`))
        .addColumn('metadata', 'jsonb', col => col.defaultTo((0, kysely_1.sql) `'{}'::jsonb`))
        .addColumn('created_by', 'uuid')
        .addColumn('created_at', 'timestamptz', col => col.defaultTo((0, kysely_1.sql) `CURRENT_TIMESTAMP`))
        .addColumn('updated_at', 'timestamptz', col => col.defaultTo((0, kysely_1.sql) `CURRENT_TIMESTAMP`))
        .addColumn('deleted_at', 'timestamptz')
        .execute();
    // Create sheets table (worksheets within a spreadsheet)
    await db.schema
        .createTable('sheets')
        .ifNotExists()
        .addColumn('id', 'uuid', col => col.primaryKey().defaultTo((0, kysely_1.sql) `gen_random_uuid()`))
        .addColumn('spreadsheet_id', 'uuid', col => col.notNull())
        .addColumn('name', 'varchar(255)', col => col.notNull())
        .addColumn('order_index', 'integer', col => col.defaultTo(0))
        .addColumn('row_count', 'integer', col => col.defaultTo(1000))
        .addColumn('column_count', 'integer', col => col.defaultTo(26))
        .addColumn('frozen_rows', 'integer', col => col.defaultTo(0))
        .addColumn('frozen_columns', 'integer', col => col.defaultTo(0))
        .addColumn('hidden_rows', 'jsonb', col => col.defaultTo((0, kysely_1.sql) `'[]'::jsonb`))
        .addColumn('hidden_columns', 'jsonb', col => col.defaultTo((0, kysely_1.sql) `'[]'::jsonb`))
        .addColumn('row_heights', 'jsonb', col => col.defaultTo((0, kysely_1.sql) `'{}'::jsonb`))
        .addColumn('column_widths', 'jsonb', col => col.defaultTo((0, kysely_1.sql) `'{}'::jsonb`))
        .addColumn('config', 'jsonb', col => col.defaultTo((0, kysely_1.sql) `'{}'::jsonb`))
        .addColumn('created_at', 'timestamptz', col => col.defaultTo((0, kysely_1.sql) `CURRENT_TIMESTAMP`))
        .addColumn('updated_at', 'timestamptz', col => col.defaultTo((0, kysely_1.sql) `CURRENT_TIMESTAMP`))
        .execute();
    // Add foreign key constraint only if spreadsheets.id is UUID type (not TEXT from migration 034)
    await (0, kysely_1.sql) `
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'spreadsheets'
        AND column_name = 'id' AND udt_name = 'uuid'
      ) THEN
        BEGIN
          ALTER TABLE sheets
            ADD CONSTRAINT sheets_spreadsheet_id_fkey
            FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id) ON DELETE CASCADE;
        EXCEPTION WHEN duplicate_object THEN NULL; END;
      END IF;
    END $$;
  `.execute(db);
    // Create cells table (actual cell data)
    await db.schema
        .createTable('cells')
        .ifNotExists()
        .addColumn('id', 'uuid', col => col.primaryKey().defaultTo((0, kysely_1.sql) `gen_random_uuid()`))
        .addColumn('sheet_id', 'uuid', col => col.notNull().references('sheets.id').onDelete('cascade'))
        .addColumn('row_index', 'integer', col => col.notNull())
        .addColumn('column_index', 'integer', col => col.notNull())
        .addColumn('cell_ref', 'varchar(20)', col => col.notNull()) // A1, B2, etc.
        .addColumn('value', 'text')
        .addColumn('display_value', 'text')
        .addColumn('data_type', 'varchar(20)', col => col.defaultTo('text'))
        // data_type: text, number, date, datetime, boolean, formula, array, object
        .addColumn('formula', 'text')
        .addColumn('formula_result', 'jsonb')
        .addColumn('format', 'jsonb', col => col.defaultTo((0, kysely_1.sql) `'{}'::jsonb`))
        // format includes: numberFormat, dateFormat, font, color, background, borders, alignment
        .addColumn('validation', 'jsonb')
        .addColumn('metadata', 'jsonb', col => col.defaultTo((0, kysely_1.sql) `'{}'::jsonb`))
        .addColumn('locked', 'boolean', col => col.defaultTo(false))
        .addColumn('comment', 'text')
        .addColumn('updated_by', 'uuid')
        .addColumn('updated_at', 'timestamptz', col => col.defaultTo((0, kysely_1.sql) `CURRENT_TIMESTAMP`))
        .execute();
    // Create formulas table (formula dependencies and calculation order)
    await db.schema
        .createTable('formulas')
        .ifNotExists()
        .addColumn('id', 'uuid', col => col.primaryKey().defaultTo((0, kysely_1.sql) `gen_random_uuid()`))
        .addColumn('cell_id', 'uuid', col => col.notNull().references('cells.id').onDelete('cascade'))
        .addColumn('sheet_id', 'uuid', col => col.notNull().references('sheets.id').onDelete('cascade'))
        .addColumn('formula_text', 'text', col => col.notNull())
        .addColumn('parsed_ast', 'jsonb') // Abstract Syntax Tree
        .addColumn('dependencies', 'jsonb', col => col.defaultTo((0, kysely_1.sql) `'[]'::jsonb`))
        // Array of cell references this formula depends on
        .addColumn('dependents', 'jsonb', col => col.defaultTo((0, kysely_1.sql) `'[]'::jsonb`))
        // Array of cells that depend on this formula
        .addColumn('calculation_order', 'integer')
        .addColumn('is_volatile', 'boolean', col => col.defaultTo(false))
        // Volatile formulas (NOW(), RAND()) need recalculation on every change
        .addColumn('last_calculated_at', 'timestamptz')
        .addColumn('error_message', 'text')
        .addColumn('created_at', 'timestamptz', col => col.defaultTo((0, kysely_1.sql) `CURRENT_TIMESTAMP`))
        .addColumn('updated_at', 'timestamptz', col => col.defaultTo((0, kysely_1.sql) `CURRENT_TIMESTAMP`))
        .execute();
    // Create cell_versions table (version history)
    await db.schema
        .createTable('cell_versions')
        .ifNotExists()
        .addColumn('id', 'uuid', col => col.primaryKey().defaultTo((0, kysely_1.sql) `gen_random_uuid()`))
        .addColumn('cell_id', 'uuid', col => col.notNull().references('cells.id').onDelete('cascade'))
        .addColumn('sheet_id', 'uuid', col => col.notNull().references('sheets.id').onDelete('cascade'))
        .addColumn('version_number', 'integer', col => col.notNull())
        .addColumn('value', 'text')
        .addColumn('formula', 'text')
        .addColumn('format', 'jsonb')
        .addColumn('changed_by', 'uuid')
        .addColumn('change_type', 'varchar(20)')
        // change_type: create, update, delete, formula_change, format_change
        .addColumn('change_summary', 'text')
        .addColumn('created_at', 'timestamptz', col => col.defaultTo((0, kysely_1.sql) `CURRENT_TIMESTAMP`))
        .execute();
    // Create named_ranges table
    await db.schema
        .createTable('named_ranges')
        .ifNotExists()
        .addColumn('id', 'uuid', col => col.primaryKey().defaultTo((0, kysely_1.sql) `gen_random_uuid()`))
        .addColumn('spreadsheet_id', 'uuid', col => col.notNull())
        .addColumn('sheet_id', 'uuid')
        .addColumn('name', 'varchar(255)', col => col.notNull())
        .addColumn('range', 'varchar(255)', col => col.notNull())
        // range format: Sheet1!A1:B10 or just A1:B10 for current sheet
        .addColumn('description', 'text')
        .addColumn('created_by', 'uuid')
        .addColumn('created_at', 'timestamptz', col => col.defaultTo((0, kysely_1.sql) `CURRENT_TIMESTAMP`))
        .execute();
    // Add foreign key constraints for named_ranges only if compatible types exist
    await (0, kysely_1.sql) `
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'spreadsheets'
        AND column_name = 'id' AND udt_name = 'uuid'
      ) THEN
        BEGIN
          ALTER TABLE named_ranges
            ADD CONSTRAINT named_ranges_spreadsheet_id_fkey
            FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id) ON DELETE CASCADE;
        EXCEPTION WHEN duplicate_object THEN NULL; END;
      END IF;
    END $$;
  `.execute(db);
    await (0, kysely_1.sql) `
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'sheets'
      ) THEN
        BEGIN
          ALTER TABLE named_ranges
            ADD CONSTRAINT named_ranges_sheet_id_fkey
            FOREIGN KEY (sheet_id) REFERENCES sheets(id) ON DELETE CASCADE;
        EXCEPTION WHEN duplicate_object THEN NULL; END;
      END IF;
    END $$;
  `.execute(db);
    // Create indexes for performance
    await db.schema
        .createIndex('idx_sheets_spreadsheet_id')
        .ifNotExists()
        .on('sheets')
        .column('spreadsheet_id')
        .execute();
    await db.schema
        .createIndex('idx_cells_sheet_id')
        .ifNotExists()
        .on('cells')
        .column('sheet_id')
        .execute();
    await db.schema
        .createIndex('idx_cells_location')
        .ifNotExists()
        .on('cells')
        .columns(['sheet_id', 'row_index', 'column_index'])
        .unique()
        .execute();
    await db.schema
        .createIndex('idx_cells_cell_ref')
        .ifNotExists()
        .on('cells')
        .columns(['sheet_id', 'cell_ref'])
        .execute();
    await db.schema
        .createIndex('idx_formulas_sheet_id')
        .ifNotExists()
        .on('formulas')
        .column('sheet_id')
        .execute();
    await db.schema
        .createIndex('idx_formulas_dependencies')
        .ifNotExists()
        .on('formulas')
        .column('dependencies')
        .using('gin')
        .execute();
    await db.schema
        .createIndex('idx_cell_versions_cell_id')
        .ifNotExists()
        .on('cell_versions')
        .column('cell_id')
        .execute();
    await db.schema
        .createIndex('idx_named_ranges_spreadsheet')
        .ifNotExists()
        .on('named_ranges')
        .columns(['spreadsheet_id', 'name'])
        .unique()
        .execute();
    // Create triggers for updated_at
    await (0, kysely_1.sql) `
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ language 'plpgsql';
  `.execute(db);
    await (0, kysely_1.sql) `DROP TRIGGER IF EXISTS update_spreadsheets_updated_at ON spreadsheets`.execute(db);
    await (0, kysely_1.sql) `CREATE TRIGGER update_spreadsheets_updated_at BEFORE UPDATE
    ON spreadsheets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();`.execute(db);
    await (0, kysely_1.sql) `DROP TRIGGER IF EXISTS update_sheets_updated_at ON sheets`.execute(db);
    await (0, kysely_1.sql) `CREATE TRIGGER update_sheets_updated_at BEFORE UPDATE
    ON sheets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();`.execute(db);
    await (0, kysely_1.sql) `
    CREATE TRIGGER update_cells_updated_at BEFORE UPDATE
    ON cells FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `.execute(db);
    await (0, kysely_1.sql) `
    CREATE TRIGGER update_formulas_updated_at BEFORE UPDATE
    ON formulas FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `.execute(db);
}
async function down(db) {
    // Drop triggers
    await (0, kysely_1.sql) `DROP TRIGGER IF EXISTS update_spreadsheets_updated_at ON spreadsheets`.execute(db);
    await (0, kysely_1.sql) `DROP TRIGGER IF EXISTS update_sheets_updated_at ON sheets`.execute(db);
    await (0, kysely_1.sql) `DROP TRIGGER IF EXISTS update_cells_updated_at ON cells`.execute(db);
    await (0, kysely_1.sql) `DROP TRIGGER IF EXISTS update_formulas_updated_at ON formulas`.execute(db);
    await (0, kysely_1.sql) `DROP FUNCTION IF EXISTS update_updated_at_column()`.execute(db);
    // Drop indexes
    await db.schema.dropIndex('idx_named_ranges_spreadsheet').execute();
    await db.schema.dropIndex('idx_cell_versions_cell_id').execute();
    await db.schema.dropIndex('idx_formulas_dependencies').execute();
    await db.schema.dropIndex('idx_formulas_sheet_id').execute();
    await db.schema.dropIndex('idx_cells_cell_ref').execute();
    await db.schema.dropIndex('idx_cells_location').execute();
    await db.schema.dropIndex('idx_cells_sheet_id').execute();
    await db.schema.dropIndex('idx_sheets_spreadsheet_id').execute();
    // Drop tables in reverse order
    await db.schema.dropTable('named_ranges').execute();
    await db.schema.dropTable('cell_versions').execute();
    await db.schema.dropTable('formulas').execute();
    await db.schema.dropTable('cells').execute();
    await db.schema.dropTable('sheets').execute();
    await db.schema.dropTable('spreadsheets').execute();
}
//# sourceMappingURL=20250924160000_create_spreadsheet_tables.js.map