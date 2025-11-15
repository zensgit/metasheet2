"use strict";
/**
 * Migration Template
 *
 * Purpose: [Describe what this migration does]
 * Tables: [List the tables this migration affects]
 * Breaking: [Yes/No - Does this introduce breaking changes?]
 *
 * Usage:
 * 1. Copy this template to a new file
 * 2. Rename to: YYYYMMDDHHMMSS_descriptive_name.ts
 * 3. Implement the up() and down() methods
 * 4. Add idempotency checks (hasTable, hasColumn, etc.)
 * 5. Test by running the migration twice
 *
 * Example filename: 20251029120000_create_user_preferences.ts
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.up = up;
exports.down = down;
const kysely_1 = require("kysely");
const _patterns_1 = require("./_patterns");
/**
 * Apply the migration
 *
 * This function should:
 * - Check if changes already exist (idempotency)
 * - Create tables, indexes, constraints
 * - Migrate data if needed
 * - Use IF NOT EXISTS where possible
 */
async function up(db) {
    // 1. Check if table already exists (using helper from _patterns.ts)
    const tableExists = await (0, _patterns_1.checkTableExists)(db, 'your_table_name');
    if (tableExists) {
        console.log('[Migration] Table your_table_name already exists, skipping creation');
        return;
    }
    console.log('[Migration] Creating table: your_table_name');
    // 2. Create the table
    await db.schema
        .createTable('your_table_name')
        .ifNotExists()
        // Primary key with UUID default
        .addColumn('id', 'text', col => col.primaryKey().defaultTo((0, kysely_1.sql) `gen_random_uuid()::text`))
        // Required text column
        .addColumn('name', 'text', col => col.notNull())
        // Optional text column
        .addColumn('description', 'text')
        // JSON column
        .addColumn('metadata', 'jsonb')
        // Boolean with default
        .addColumn('is_active', 'boolean', col => col.notNull().defaultTo(true))
        // Timestamps
        .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo((0, kysely_1.sql) `NOW()`))
        .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo((0, kysely_1.sql) `NOW()`))
        .execute();
    console.log('[Migration] Table created successfully');
    // 3. Create indexes (separate statements)
    console.log('[Migration] Creating indexes...');
    await db.schema
        .createIndex('idx_your_table_name_name')
        .ifNotExists()
        .on('your_table_name')
        .column('name')
        .execute();
    await db.schema
        .createIndex('idx_your_table_name_active')
        .ifNotExists()
        .on('your_table_name')
        .column('is_active')
        .execute();
    // Composite index
    await db.schema
        .createIndex('idx_your_table_name_name_active')
        .ifNotExists()
        .on('your_table_name')
        .columns(['name', 'is_active'])
        .execute();
    // Partial index (with WHERE clause)
    await db.schema
        .createIndex('idx_your_table_name_active_only')
        .ifNotExists()
        .on('your_table_name')
        .column('name')
        .where(kysely_1.sql.ref('is_active'), '=', true)
        .execute();
    console.log('[Migration] Indexes created successfully');
    // 4. Add constraints (optional)
    // Note: Constraints are harder to make idempotent
    // Consider using table-level constraints in createTable instead
    // 5. Create triggers (optional)
    /*
    await sql`
      CREATE OR REPLACE FUNCTION update_timestamp()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `.execute(db)
  
    await sql`
      CREATE TRIGGER trigger_your_table_name_updated_at
      BEFORE UPDATE ON your_table_name
      FOR EACH ROW
      EXECUTE FUNCTION update_timestamp();
    `.execute(db)
    */
    console.log('[Migration] Migration completed successfully');
}
/**
 * Rollback the migration
 *
 * This function should:
 * - Drop triggers
 * - Drop constraints
 * - Drop indexes
 * - Drop tables
 * - Use IF EXISTS where possible
 * - Be safe to run multiple times
 */
async function down(db) {
    console.log('[Migration] Rolling back: dropping your_table_name');
    // 1. Drop triggers (if any)
    /*
    await sql`
      DROP TRIGGER IF EXISTS trigger_your_table_name_updated_at
      ON your_table_name;
    `.execute(db)
    */
    // 2. Drop indexes (optional, will be dropped with table)
    /*
    await db.schema
      .dropIndex('idx_your_table_name_name')
      .ifExists()
      .execute()
    */
    // 3. Drop the table (ifExists makes the check redundant)
    await db.schema
        .dropTable('your_table_name')
        .ifExists()
        .execute();
    console.log('[Migration] Table dropped successfully');
    console.log('[Migration] Rollback completed successfully');
}
//# sourceMappingURL=_template.js.map