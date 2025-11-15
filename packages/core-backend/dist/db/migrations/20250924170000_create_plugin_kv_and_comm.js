"use strict";
/**
 * Migration: Create Plugin KV and Communication tables
 * Timestamp: 2025-09-24 17:00:00
 *
 * Fixed version that resolves "db.fn.now is not a function" error
 * by using proper sql template literals instead of db.fn.now()
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.up = up;
exports.down = down;
const kysely_1 = require("kysely");
async function up(db) {
    // Create plugin_kv table for persistent plugin storage
    await db.schema
        .createTable('plugin_kv')
        .ifNotExists()
        .addColumn('plugin', 'text', (col) => col.notNull())
        .addColumn('key', 'text', (col) => col.notNull())
        .addColumn('value', 'jsonb', (col) => col.notNull().defaultTo(JSON.stringify({})))
        .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo((0, kysely_1.sql) `NOW()`))
        .addPrimaryKeyConstraint('plugin_kv_pkey', ['plugin', 'key'])
        .execute();
    // Create plugin_comm_apis registry for future plugin communication
    await db.schema
        .createTable('plugin_comm_apis')
        .ifNotExists()
        .addColumn('plugin', 'text', (col) => col.notNull())
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('meta', 'jsonb', (col) => col.notNull().defaultTo(JSON.stringify({})))
        .addColumn('registered_at', 'timestamptz', (col) => col.notNull().defaultTo((0, kysely_1.sql) `NOW()`))
        .addPrimaryKeyConstraint('plugin_comm_apis_pkey', ['plugin', 'name'])
        .execute();
    // Add trigger for updated_at on plugin_kv
    await (0, kysely_1.sql) `
    CREATE OR REPLACE TRIGGER update_plugin_kv_updated_at
    BEFORE UPDATE ON plugin_kv
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `.execute(db);
}
async function down(db) {
    // Drop trigger first
    await (0, kysely_1.sql) `DROP TRIGGER IF EXISTS update_plugin_kv_updated_at ON plugin_kv`.execute(db);
    // Drop tables in reverse order
    await db.schema.dropTable('plugin_comm_apis').ifExists().execute();
    await db.schema.dropTable('plugin_kv').ifExists().execute();
}
//# sourceMappingURL=20250924170000_create_plugin_kv_and_comm.js.map