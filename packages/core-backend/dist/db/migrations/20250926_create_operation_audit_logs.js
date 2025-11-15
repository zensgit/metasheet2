"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.up = up;
const kysely_1 = require("kysely");
async function up(db) {
    // Create operation_audit_logs table (minimal placeholder to satisfy startup writes)
    await db.schema
        .createTable('operation_audit_logs')
        .ifNotExists()
        .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo((0, kysely_1.sql) `gen_random_uuid()`))
        .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo((0, kysely_1.sql) `now()`))
        .addColumn('actor_id', 'varchar(100)')
        .addColumn('actor_type', 'varchar(50)')
        .addColumn('action', 'varchar(100)', (col) => col.notNull())
        .addColumn('resource_type', 'varchar(100)')
        .addColumn('resource_id', 'varchar(200)')
        .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo((0, kysely_1.sql) `'{}'::jsonb`))
        .execute();
    // Indexes (conditional on column existence)
    // Check if created_at column exists before creating index
    const hasCreatedAt = await (0, kysely_1.sql) `
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'operation_audit_logs'
      AND column_name = 'created_at'
    ) as exists
  `.execute(db);
    if (hasCreatedAt.rows[0]?.exists) {
        await db.schema
            .createIndex('idx_operation_audit_logs_created')
            .ifNotExists()
            .on('operation_audit_logs')
            .column('created_at')
            .execute();
    }
    // Check if actor_id column exists before creating index
    const hasActorId = await (0, kysely_1.sql) `
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'operation_audit_logs'
      AND column_name = 'actor_id'
    ) as exists
  `.execute(db);
    if (hasActorId.rows[0]?.exists) {
        await db.schema
            .createIndex('idx_operation_audit_logs_actor')
            .ifNotExists()
            .on('operation_audit_logs')
            .column('actor_id')
            .execute();
    }
    // Check if resource_type column exists before creating index
    const hasResourceColumns = await (0, kysely_1.sql) `
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'operation_audit_logs'
      AND column_name IN ('resource_type', 'resource_id')
      GROUP BY table_name
      HAVING COUNT(*) = 2
    ) as exists
  `.execute(db);
    if (hasResourceColumns.rows[0]?.exists) {
        await db.schema
            .createIndex('idx_operation_audit_logs_resource')
            .ifNotExists()
            .on('operation_audit_logs')
            .columns(['resource_type', 'resource_id'])
            .execute();
    }
    // Add commonly used audit columns if missing
    await (0, kysely_1.sql) `ALTER TABLE operation_audit_logs
    ADD COLUMN IF NOT EXISTS request_id varchar(100),
    ADD COLUMN IF NOT EXISTS ip_address varchar(64),
    ADD COLUMN IF NOT EXISTS ip varchar(64),
    ADD COLUMN IF NOT EXISTS user_agent text,
    ADD COLUMN IF NOT EXISTS route text,
    ADD COLUMN IF NOT EXISTS status_code int,
    ADD COLUMN IF NOT EXISTS latency_ms int,
    ADD COLUMN IF NOT EXISTS meta jsonb
  `.execute(db);
}
//# sourceMappingURL=20250926_create_operation_audit_logs.js.map