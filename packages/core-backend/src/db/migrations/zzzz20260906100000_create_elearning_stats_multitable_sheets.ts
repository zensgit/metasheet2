import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import {
  ELEARNING_PROJECTION_SYSTEM_KIND,
  ELEARNING_PROJECTION_SYSTEM_OWNER,
  ELEARNING_STATS_MULTITABLE_SHEETS_TABLE,
} from '../../multitable/elearning-projection-constants'

const EXPECTED_COLUMNS = [
  { name: 'org_id', type: 'text', nullable: false, default: null },
  { name: 'base_id', type: 'text', nullable: false, default: null },
  { name: 'sheet_id', type: 'text', nullable: false, default: null },
  { name: 'created_at', type: 'timestamp with time zone', nullable: false, default: 'now()' },
  { name: 'updated_at', type: 'timestamp with time zone', nullable: false, default: 'now()' },
] as const

const EXPECTED_CONSTRAINTS = [
  {
    name: 'elearning_stats_multitable_sheets_base_id_key',
    definition: 'UNIQUE (base_id)',
  },
  {
    name: 'elearning_stats_multitable_sheets_identity_chk',
    definition: "CHECK (org_id = btrim(org_id) AND org_id <> ''::text AND char_length(org_id) <= 512 AND base_id ~ '^base_el_stats_[0-9a-f]{32}$'::text AND sheet_id ~ '^sht_el_stats_[0-9a-f]{32}$'::text)",
  },
  {
    name: 'elearning_stats_multitable_sheets_pkey',
    definition: 'PRIMARY KEY (org_id)',
  },
  {
    name: 'elearning_stats_multitable_sheets_sheet_id_key',
    definition: 'UNIQUE (sheet_id)',
  },
] as const

function drift(detail: string): never {
  throw new Error(`elearning stats multitable migration drift: ${detail}`)
}

async function mappingTablePresent(db: Kysely<unknown>): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    SELECT to_regclass(${ELEARNING_STATS_MULTITABLE_SHEETS_TABLE}) IS NOT NULL AS present
  `.execute(db)
  return result.rows[0]?.present === true
}

export async function assertElearningStatsMultitableSheetsSchema(
  db: Kysely<unknown>,
): Promise<void> {
  const columns = await sql<{
    name: string
    type: string
    nullable: boolean
    default: string | null
  }>`
    SELECT
      attribute.attname AS name,
      format_type(attribute.atttypid, attribute.atttypmod) AS type,
      NOT attribute.attnotnull AS nullable,
      pg_get_expr(default_row.adbin, default_row.adrelid) AS default
      FROM pg_attribute attribute
      JOIN pg_class table_row ON table_row.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      LEFT JOIN pg_attrdef default_row
        ON default_row.adrelid = attribute.attrelid
       AND default_row.adnum = attribute.attnum
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${ELEARNING_STATS_MULTITABLE_SHEETS_TABLE}
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY attribute.attnum
  `.execute(db)
  if (JSON.stringify(columns.rows) !== JSON.stringify(EXPECTED_COLUMNS)) drift('column set')

  const constraints = await sql<{ name: string; definition: string }>`
    SELECT constraint_row.conname AS name,
           pg_get_constraintdef(constraint_row.oid, true) AS definition
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${ELEARNING_STATS_MULTITABLE_SHEETS_TABLE}
     ORDER BY constraint_row.conname
  `.execute(db)
  if (JSON.stringify(constraints.rows) !== JSON.stringify(EXPECTED_CONSTRAINTS)) {
    drift('constraint set')
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS elearning_stats_multitable_sheets (
      org_id text PRIMARY KEY,
      base_id text NOT NULL UNIQUE,
      sheet_id text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_stats_multitable_sheets_identity_chk CHECK (
        org_id = btrim(org_id)
        AND org_id <> ''
        AND char_length(org_id) <= 512
        AND base_id ~ '^base_el_stats_[0-9a-f]{32}$'
        AND sheet_id ~ '^sht_el_stats_[0-9a-f]{32}$'
      )
    )
  `.execute(db)
  await assertElearningStatsMultitableSheetsSchema(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await mappingTablePresent(db))) return
  await sql`
    DELETE FROM meta_sheets sheet
      USING elearning_stats_multitable_sheets mapping
     WHERE sheet.id = mapping.sheet_id
       AND sheet.base_id = mapping.base_id
       AND to_jsonb(sheet) ->> 'system_kind' = ${ELEARNING_PROJECTION_SYSTEM_KIND}
  `.execute(db)
  await sql`
    DELETE FROM meta_bases base
      USING elearning_stats_multitable_sheets mapping
     WHERE base.id = mapping.base_id
       AND base.owner_id = ${ELEARNING_PROJECTION_SYSTEM_OWNER}
  `.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_stats_multitable_sheets`.execute(db)
}
