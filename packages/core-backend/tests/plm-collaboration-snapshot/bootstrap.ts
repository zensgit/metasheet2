import type { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { bootstrapPlmBaseTestDb } from '../plm-bom-review/base-bootstrap'
import { up as recordLocks } from '../../src/db/migrations/zzzz20260612140000_add_meta_record_locked'
import { up as bom } from '../../src/db/migrations/zzzz20261002010000_create_plm_bom_reviews'

// Isolated fixture only. Reuses bootstrapPlmBaseTestDb unchanged (minimal predecessor plus the
// eight history/operation migrations). Not a fresh full-install chain. The real record-lock
// migration supplies locked_at, then this adds the columns and relations the guards read, and
// the old BOM migration when coexistence is selected.
export async function bootstrapPlmCollaborationSnapshotTestDb(
  pool: Pool,
  options?: { includeBom?: boolean },
): Promise<void> {
  await bootstrapPlmBaseTestDb(pool)
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
      created_at timestamptz,
      deleted_at timestamptz
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
