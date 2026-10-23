import type { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { bootstrapPlmBaseTestDb } from '../plm-bom-review/base-bootstrap'
import { up as recordLocks } from '../../src/db/migrations/zzzz20260612140000_add_meta_record_locked'
import { up as bom } from '../../src/db/migrations/zzzz20261002010000_create_plm_bom_reviews'

const OWNED_OPERATION_FOREIGN_KEYS = [
  ['meta_record_revisions', 'fk_mrr_operation'],
  ['meta_record_version_markers', 'fk_mrvm_operation'],
] as const

// The shared history migration accepts a constraint name anywhere in the database. A foreign
// schema with the canonical names then leaves this serving schema without its deferred keys.
// Repair only the current schema. A wrong local shape is refused and is not rewritten.
async function ensureOwnedOperationForeignKeys(pool: Pool): Promise<void> {
  for (const [relation, name] of OWNED_OPERATION_FOREIGN_KEYS) {
    const found = await pool.query(
      `SELECT (
         constraint_row.condeferrable
         AND constraint_row.condeferred
         AND constraint_row.convalidated
         AND constraint_row.confmatchtype = 's'
         AND constraint_row.confupdtype = 'a'
         AND constraint_row.confdeltype = 'a'
         AND referenced_namespace.nspname = current_schema()
         AND referenced.relname = 'meta_record_history_operations'
         AND (
           SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
           FROM pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, ordinality)
           JOIN pg_catalog.pg_attribute attribute
             ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
         ) = ARRAY['sheet_id', 'operation_id']::text[]
         AND (
           SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
           FROM pg_catalog.unnest(constraint_row.confkey) WITH ORDINALITY AS key(attnum, ordinality)
           JOIN pg_catalog.pg_attribute attribute
             ON attribute.attrelid = referenced.oid AND attribute.attnum = key.attnum
         ) = ARRAY['sheet_id', 'operation_id']::text[]
       ) AS shape_ok
         FROM pg_catalog.pg_constraint constraint_row
         JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         JOIN pg_catalog.pg_class referenced ON referenced.oid = constraint_row.confrelid
         JOIN pg_catalog.pg_namespace referenced_namespace ON referenced_namespace.oid = referenced.relnamespace
        WHERE namespace.nspname = current_schema()
          AND relation.relname = $1
          AND relation.relkind = 'r'
          AND constraint_row.conname = $2
          AND constraint_row.contype = 'f'`,
      [relation, name],
    )
    if (found.rows.length > 1) {
      throw new Error(`owned ${relation} ${name} matched more than one foreign key`)
    }
    const row = found.rows[0] as { shape_ok: boolean } | undefined
    if (row) {
      if (row.shape_ok !== true) {
        throw new Error(`owned ${relation} ${name} foreign key has the wrong shape`)
      }
      continue
    }
    await pool.query(
      `ALTER TABLE ${relation}
         ADD CONSTRAINT ${name}
         FOREIGN KEY (sheet_id, operation_id)
         REFERENCES meta_record_history_operations (sheet_id, operation_id)
         DEFERRABLE INITIALLY DEFERRED`,
    )
  }
}

// Isolated fixture only. Reuses bootstrapPlmBaseTestDb unchanged (minimal predecessor plus the
// eight history/operation migrations). Not a fresh full-install chain. The real record-lock
// migration supplies locked_at, then this adds the columns and relations the guards read, and
// the old BOM migration when coexistence is selected.
export async function bootstrapPlmCollaborationSnapshotTestDb(
  pool: Pool,
  options?: { includeBom?: boolean },
): Promise<void> {
  await bootstrapPlmBaseTestDb(pool)
  await ensureOwnedOperationForeignKeys(pool)
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  await recordLocks(db)
  const lockedAt = await pool.query(
    `SELECT udt_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'meta_records'
        AND column_name = 'locked_at'`,
  )
  const lockedAtType = (lockedAt.rows[0] as { udt_name?: string } | undefined)?.udt_name
  if (lockedAtType !== 'timestamptz') {
    throw new Error(`meta_records.locked_at prerequisite is ${lockedAtType ?? 'missing'}`)
  }
  await pool.query(`
    ALTER TABLE meta_bases ADD COLUMN name text;
    ALTER TABLE meta_bases ADD COLUMN workspace_id text;
    ALTER TABLE meta_sheets ADD COLUMN name text;
    ALTER TABLE meta_sheets ADD COLUMN description text;
    ALTER TABLE meta_fields ADD COLUMN name text;
    ALTER TABLE meta_fields ADD COLUMN "order" integer;
    CREATE TABLE meta_views(
      id text PRIMARY KEY,
      sheet_id text REFERENCES meta_sheets(id),
      name text,
      type text,
      filter_info jsonb,
      sort_info jsonb,
      group_info jsonb,
      hidden_field_ids jsonb,
      config jsonb,
      created_at timestamptz
    );
    CREATE TABLE data_sources(
      id text PRIMARY KEY,
      name text,
      type text,
      config jsonb,
      owner_id text,
      is_active boolean,
      deleted_at timestamptz,
      workspace_id text,
      tenant_id text,
      scope_kind text
    );
  `)
  if (options?.includeBom !== false) await bom(db)
}
