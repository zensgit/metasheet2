"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.up = up;
exports.down = down;
/** Duplicate shim migration for CI ordering: creates approval tables if missing */
const kysely_1 = require("kysely");
async function up(db) {
    await (0, kysely_1.sql) `CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);
    // Create tables if not exist
    await (0, kysely_1.sql) `CREATE TABLE IF NOT EXISTS approval_instances (
    id text PRIMARY KEY,
    status text NOT NULL,
    version integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
    await (0, kysely_1.sql) `CREATE TABLE IF NOT EXISTS approval_records (
    id BIGSERIAL PRIMARY KEY,
    instance_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'return', 'revoke', 'transfer', 'sign')),
    actor_id TEXT NOT NULL,
    actor_name TEXT,
    comment TEXT NULL,
    reason TEXT NULL,
    from_status TEXT NULL,
    to_status TEXT NOT NULL,
    version INT NULL,
    from_version INT NULL,
    to_version INT NOT NULL DEFAULT 0,
    target_user_id TEXT NULL,
    target_step_id TEXT NULL,
    attachments JSONB DEFAULT '[]'::jsonb,
    metadata JSONB DEFAULT '{}'::jsonb,
    ip_address INET,
    user_agent TEXT,
    platform TEXT DEFAULT 'web',
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.execute(db);
    // Ensure all columns exist (for tables that existed before this migration)
    await (0, kysely_1.sql) `ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS actor_name TEXT`.execute(db);
    await (0, kysely_1.sql) `ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS reason TEXT`.execute(db);
    await (0, kysely_1.sql) `ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS version INT`.execute(db);
    await (0, kysely_1.sql) `ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS from_version INT`.execute(db);
    await (0, kysely_1.sql) `ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS to_version INT NOT NULL DEFAULT 0`.execute(db);
    // Ensure to_version has DEFAULT even if column already existed
    await (0, kysely_1.sql) `ALTER TABLE approval_records ALTER COLUMN to_version SET DEFAULT 0`.execute(db);
    await (0, kysely_1.sql) `ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS target_user_id TEXT`.execute(db);
    await (0, kysely_1.sql) `ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS target_step_id TEXT`.execute(db);
    await (0, kysely_1.sql) `ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb`.execute(db);
    await (0, kysely_1.sql) `ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`.execute(db);
    await (0, kysely_1.sql) `ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS ip_address INET`.execute(db);
    await (0, kysely_1.sql) `ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS user_agent TEXT`.execute(db);
    await (0, kysely_1.sql) `ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'web'`.execute(db);
    await (0, kysely_1.sql) `ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()`.execute(db);
    await (0, kysely_1.sql) `CREATE INDEX IF NOT EXISTS idx_approval_records_instance ON approval_records(instance_id)`.execute(db);
}
async function down(db) {
    await db.schema.dropTable('approval_records').ifExists().cascade().execute();
    await db.schema.dropTable('approval_instances').ifExists().cascade().execute();
}
//# sourceMappingURL=20250924105000_create_approval_tables.js.map