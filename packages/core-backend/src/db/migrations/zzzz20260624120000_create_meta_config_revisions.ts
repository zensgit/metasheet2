import { sql, type Kysely } from 'kysely'

// T9-R1: config/schema-change history. Append-only history of CONFIG entities (v1 records only `field`; permissions
// / views / sheet_config are R2). Parallels meta_record_revisions but for STRUCTURE, not record values.
//
// IMPORTANT: meta_config_revisions rows are NOT record data. A future read API (T9-R3) MUST apply its own
// per-entity-type config-manage gate (field → canManageFields, etc.) and MUST NOT reuse the record-history
// projection / record mask — that mask is for record values; this table holds config.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_config_revisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sheet_id text NOT NULL,
      entity_type text NOT NULL CHECK (entity_type IN ('field', 'permission', 'view', 'sheet_config')),
      entity_id text NOT NULL,
      action text NOT NULL CHECK (action IN ('create', 'update', 'delete')),
      before jsonb,
      after jsonb,
      changed_keys text[] NOT NULL DEFAULT ARRAY[]::text[],
      batch_id uuid,
      actor_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  // T9-L6 deterministic order: the sheet-level timeline reads (sheet_id, created_at DESC, id DESC).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_config_revisions_sheet_created
    ON meta_config_revisions(sheet_id, created_at DESC, id DESC)
  `.execute(db)
  // per-entity drill-down.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_config_revisions_entity
    ON meta_config_revisions(sheet_id, entity_type, entity_id, created_at DESC)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_config_revisions_entity`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_config_revisions_sheet_created`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_config_revisions`.execute(db)
}
