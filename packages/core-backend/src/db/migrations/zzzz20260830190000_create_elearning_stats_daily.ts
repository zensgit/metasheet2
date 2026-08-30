import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export const ELEARNING_STATS_DAILY_TABLE = 'elearning_stats_daily'
export const ELEARNING_STATS_DAILY_DATASET = 'department_overview'
export const ELEARNING_STATS_DAILY_IDENTITY_KEY =
  'elearning_stats_daily_org_dataset_department_date_key'
export const ELEARNING_STATS_DAILY_READ_INDEX =
  'elearning_stats_daily_org_dataset_date_idx'

const INTEGRATION_ORG_FK = 'elearning_stats_daily_integration_org_fk'
const DEPARTMENT_IDENTITY_FK = 'elearning_stats_daily_department_identity_fk'

const EXPECTED_COLUMNS = [
  { name: 'id', type: 'uuid', nullable: false, default: 'gen_random_uuid()' },
  { name: 'org_id', type: 'text', nullable: false, default: null },
  { name: 'directory_integration_id', type: 'uuid', nullable: false, default: null },
  { name: 'directory_provider', type: 'text', nullable: false, default: null },
  { name: 'department_id', type: 'uuid', nullable: false, default: null },
  { name: 'dataset', type: 'text', nullable: false, default: null },
  { name: 'stats_date', type: 'date', nullable: false, default: null },
  { name: 'period_start', type: 'timestamp with time zone', nullable: false, default: null },
  { name: 'period_end', type: 'timestamp with time zone', nullable: false, default: null },
  { name: 'source_version', type: 'text', nullable: false, default: null },
  { name: 'payload_digest', type: 'text', nullable: false, default: null },
  { name: 'suppressed', type: 'boolean', nullable: false, default: null },
  { name: 'min_group_size', type: 'integer', nullable: false, default: null },
  { name: 'assigned_count', type: 'bigint', nullable: true, default: null },
  { name: 'completed_count', type: 'bigint', nullable: true, default: null },
  { name: 'completion_rate', type: 'numeric(12,9)', nullable: true, default: null },
  { name: 'credit_average', type: 'numeric(24,9)', nullable: true, default: null },
  { name: 'credit_total', type: 'bigint', nullable: true, default: null },
  { name: 'exam_participant_count', type: 'bigint', nullable: true, default: null },
  { name: 'learner_count', type: 'bigint', nullable: true, default: null },
  { name: 'learning_seconds', type: 'bigint', nullable: true, default: null },
  { name: 'member_count', type: 'bigint', nullable: true, default: null },
  { name: 'overdue_count', type: 'bigint', nullable: true, default: null },
  { name: 'projected_version', type: 'bigint', nullable: false, default: '1' },
  { name: 'last_projected_at', type: 'timestamp with time zone', nullable: false, default: 'now()' },
  { name: 'last_error', type: 'text', nullable: true, default: null },
  { name: 'created_at', type: 'timestamp with time zone', nullable: false, default: 'now()' },
  { name: 'updated_at', type: 'timestamp with time zone', nullable: false, default: 'now()' },
] as const

const EXPECTED_CHECKS = [
  {
    name: 'elearning_stats_daily_identity_chk',
    definition: `CHECK (((org_id = btrim(org_id)) AND (org_id <> ''::text) AND (char_length(org_id) <= 512) AND (directory_provider = btrim(directory_provider)) AND (directory_provider <> ''::text) AND (char_length(directory_provider) <= 128) AND (dataset = 'department_overview'::text) AND (source_version = btrim(source_version)) AND (source_version <> ''::text) AND (char_length(source_version) <= 512) AND (payload_digest ~ '^[0-9a-f]{64}$'::text)))`,
  },
  {
    name: 'elearning_stats_daily_period_chk',
    definition: `CHECK (((period_start = ((stats_date)::timestamp without time zone AT TIME ZONE 'UTC'::text)) AND (period_end = (((stats_date + 1))::timestamp without time zone AT TIME ZONE 'UTC'::text))))`,
  },
  {
    name: 'elearning_stats_daily_threshold_chk',
    definition: 'CHECK ((min_group_size >= 5))',
  },
  {
    name: 'elearning_stats_daily_projection_state_chk',
    definition: `CHECK (((projected_version > 0) AND ((last_error IS NULL) OR ((last_error ~ '^[A-Z][A-Z0-9_]{1,63}$'::text) AND (last_error = btrim(last_error))))))`,
  },
  {
    name: 'elearning_stats_daily_suppression_chk',
    definition: `CHECK (((suppressed AND (assigned_count IS NULL) AND (completed_count IS NULL) AND (completion_rate IS NULL) AND (credit_average IS NULL) AND (credit_total IS NULL) AND (exam_participant_count IS NULL) AND (learner_count IS NULL) AND (learning_seconds IS NULL) AND (member_count IS NULL) AND (overdue_count IS NULL)) OR ((NOT suppressed) AND (assigned_count IS NOT NULL) AND (completed_count IS NOT NULL) AND (completion_rate IS NOT NULL) AND (credit_average IS NOT NULL) AND (credit_total IS NOT NULL) AND (exam_participant_count IS NOT NULL) AND (learner_count IS NOT NULL) AND (learning_seconds IS NOT NULL) AND (member_count IS NOT NULL) AND (overdue_count IS NOT NULL))))`,
  },
  {
    name: 'elearning_stats_daily_metrics_chk',
    definition: `CHECK ((suppressed OR ((assigned_count >= 0) AND (completed_count >= 0) AND (completed_count <= assigned_count) AND (completion_rate >= (0)::numeric) AND (completion_rate <= (1)::numeric) AND (exam_participant_count >= 0) AND (learner_count >= 0) AND (learning_seconds >= 0) AND (member_count >= 0) AND (overdue_count >= 0) AND (overdue_count <= assigned_count))))`,
  },
] as const

type CatalogColumn = {
  name: string
  type: string
  nullable: boolean
  default: string | null
}

type CatalogConstraint = {
  type: string
  columns: string[]
  referenced_table: string | null
  referenced_columns: string[] | null
  deferrable: boolean
  deferred: boolean
  validated: boolean
  delete_action: string
  update_action: string
  match_type: string
}

function canonicalSql(value: string): string {
  return value.replaceAll('"', '').replace(/\s+/g, '')
}

function drift(detail: string): never {
  throw new Error(`elearning stats daily migration drift: ${detail}`)
}

async function relationPresent(db: Kysely<unknown>, name: string): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    SELECT to_regclass(${sql.val(name)}) IS NOT NULL AS present
  `.execute(db)
  return result.rows[0]?.present === true
}

async function assertColumns(db: Kysely<unknown>): Promise<void> {
  const result = await sql<CatalogColumn>`
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
       AND table_row.relname = ${ELEARNING_STATS_DAILY_TABLE}
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY attribute.attnum
  `.execute(db)
  if (JSON.stringify(result.rows) !== JSON.stringify(EXPECTED_COLUMNS)) {
    drift('column set')
  }
}

async function readConstraint(
  db: Kysely<unknown>,
  name: string,
): Promise<CatalogConstraint | null> {
  const result = await sql<CatalogConstraint>`
    SELECT
      constraint_row.contype::text AS type,
      ARRAY(
        SELECT attribute.attname
          FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = constraint_row.conrelid
           AND attribute.attnum = key.attnum
         ORDER BY key.position
      )::text[] AS columns,
      referenced_table.relname AS referenced_table,
      CASE WHEN constraint_row.confkey IS NULL THEN NULL ELSE ARRAY(
        SELECT attribute.attname
          FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = constraint_row.confrelid
           AND attribute.attnum = key.attnum
         ORDER BY key.position
      )::text[] END AS referenced_columns,
      constraint_row.condeferrable AS deferrable,
      constraint_row.condeferred AS deferred,
      constraint_row.convalidated AS validated,
      constraint_row.confdeltype::text AS delete_action,
      constraint_row.confupdtype::text AS update_action,
      constraint_row.confmatchtype::text AS match_type
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      LEFT JOIN pg_class referenced_table ON referenced_table.oid = constraint_row.confrelid
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${ELEARNING_STATS_DAILY_TABLE}
       AND constraint_row.conname = ${name}
  `.execute(db)
  return result.rows[0] ?? null
}

async function assertConstraint(
  db: Kysely<unknown>,
  expected: {
    name: string
    type: 'f' | 'p' | 'u'
    columns: string[]
    referencedTable?: string
    referencedColumns?: string[]
    deleteAction?: string
    updateAction?: string
    matchType?: string
  },
): Promise<void> {
  const actual = await readConstraint(db, expected.name)
  if (
    !actual
    || actual.type !== expected.type
    || actual.columns.join('\0') !== expected.columns.join('\0')
    || actual.referenced_table !== (expected.referencedTable ?? null)
    || (actual.referenced_columns ?? []).join('\0')
      !== (expected.referencedColumns ?? []).join('\0')
    || actual.deferrable
    || actual.deferred
    || !actual.validated
    || (expected.deleteAction !== undefined && actual.delete_action !== expected.deleteAction)
    || (expected.updateAction !== undefined && actual.update_action !== expected.updateAction)
    || (expected.matchType !== undefined && actual.match_type !== expected.matchType)
  ) drift(expected.name)
}

async function assertConstraintSet(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ name: string; type: string }>`
    SELECT constraint_row.conname AS name, constraint_row.contype::text AS type
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${ELEARNING_STATS_DAILY_TABLE}
       AND constraint_row.contype IN ('p', 'u', 'f')
     ORDER BY constraint_row.conname
  `.execute(db)
  const expected = [
    { name: DEPARTMENT_IDENTITY_FK, type: 'f' },
    { name: INTEGRATION_ORG_FK, type: 'f' },
    { name: ELEARNING_STATS_DAILY_IDENTITY_KEY, type: 'u' },
    { name: 'elearning_stats_daily_pkey', type: 'p' },
  ].sort((left, right) => left.name.localeCompare(right.name))
  if (JSON.stringify(result.rows) !== JSON.stringify(expected)) drift('constraint set')
}

async function assertChecks(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ name: string; definition: string; validated: boolean }>`
    SELECT
      constraint_row.conname AS name,
      pg_get_constraintdef(constraint_row.oid) AS definition,
      constraint_row.convalidated AS validated
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${ELEARNING_STATS_DAILY_TABLE}
       AND constraint_row.contype = 'c'
     ORDER BY constraint_row.conname
  `.execute(db)
  const actual = result.rows.map((row) => ({
    definition: canonicalSql(row.definition),
    name: row.name,
    validated: row.validated,
  }))
  const expected = EXPECTED_CHECKS.map((row) => ({
    definition: canonicalSql(row.definition),
    name: row.name,
    validated: true,
  })).sort((left, right) => left.name.localeCompare(right.name))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) drift('check constraint set')
}

async function assertReadIndex(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{
    unique: boolean
    valid: boolean
    columns: string[]
    descending: boolean[]
    predicate: string | null
  }>`
    SELECT
      index_row.indisunique AS unique,
      index_row.indisvalid AS valid,
      ARRAY(
        SELECT attribute.attname
          FROM unnest(index_row.indkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = index_row.indrelid
           AND attribute.attnum = key.attnum
         WHERE key.position <= index_row.indnkeyatts
         ORDER BY key.position
      )::text[] AS columns,
      ARRAY(
        SELECT (index_row.indoption[key.position - 1] & 1) = 1
          FROM unnest(index_row.indkey) WITH ORDINALITY AS key(attnum, position)
         WHERE key.position <= index_row.indnkeyatts
         ORDER BY key.position
      )::boolean[] AS descending,
      pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
      FROM pg_class index_rel
      JOIN pg_index index_row ON index_row.indexrelid = index_rel.oid
      JOIN pg_class table_row ON table_row.oid = index_row.indrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${ELEARNING_STATS_DAILY_TABLE}
       AND index_rel.relname = ${ELEARNING_STATS_DAILY_READ_INDEX}
  `.execute(db)
  const row = result.rows[0]
  if (
    !row
    || row.unique
    || !row.valid
    || row.predicate !== null
    || row.columns.join('\0') !== 'org_id\0dataset\0stats_date\0department_id'
    || row.descending.join('\0') !== 'false\0false\0true\0false'
  ) drift(ELEARNING_STATS_DAILY_READ_INDEX)
}

export async function assertElearningStatsDailySchema(
  db: Kysely<unknown>,
): Promise<void> {
  if (
    !(await relationPresent(db, ELEARNING_STATS_DAILY_TABLE))
    || !(await relationPresent(db, ELEARNING_STATS_DAILY_READ_INDEX))
  ) drift('object set')
  await assertColumns(db)
  await assertConstraintSet(db)
  await assertConstraint(db, {
    name: 'elearning_stats_daily_pkey',
    type: 'p',
    columns: ['id'],
  })
  await assertConstraint(db, {
    name: ELEARNING_STATS_DAILY_IDENTITY_KEY,
    type: 'u',
    columns: ['org_id', 'dataset', 'department_id', 'stats_date'],
  })
  await assertConstraint(db, {
    name: INTEGRATION_ORG_FK,
    type: 'f',
    columns: ['directory_integration_id', 'org_id'],
    referencedTable: 'directory_integrations',
    referencedColumns: ['id', 'org_id'],
    deleteAction: 'r',
    updateAction: 'a',
    matchType: 's',
  })
  await assertConstraint(db, {
    name: DEPARTMENT_IDENTITY_FK,
    type: 'f',
    columns: ['department_id', 'directory_integration_id', 'directory_provider'],
    referencedTable: 'directory_departments',
    referencedColumns: ['id', 'integration_id', 'provider'],
    deleteAction: 'r',
    updateAction: 'a',
    matchType: 's',
  })
  await assertChecks(db)
  await assertReadIndex(db)
}

async function createSchema(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
  await sql`
    CREATE TABLE elearning_stats_daily (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      directory_integration_id uuid NOT NULL,
      directory_provider text NOT NULL,
      department_id uuid NOT NULL,
      dataset text NOT NULL,
      stats_date date NOT NULL,
      period_start timestamptz NOT NULL,
      period_end timestamptz NOT NULL,
      source_version text NOT NULL,
      payload_digest text NOT NULL,
      suppressed boolean NOT NULL,
      min_group_size integer NOT NULL,
      assigned_count bigint,
      completed_count bigint,
      completion_rate numeric(12, 9),
      credit_average numeric(24, 9),
      credit_total bigint,
      exam_participant_count bigint,
      learner_count bigint,
      learning_seconds bigint,
      member_count bigint,
      overdue_count bigint,
      projected_version bigint NOT NULL DEFAULT 1,
      last_projected_at timestamptz NOT NULL DEFAULT now(),
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_stats_daily_org_dataset_department_date_key
        UNIQUE (org_id, dataset, department_id, stats_date),
      CONSTRAINT elearning_stats_daily_integration_org_fk
        FOREIGN KEY (directory_integration_id, org_id)
        REFERENCES directory_integrations (id, org_id) ON DELETE RESTRICT,
      CONSTRAINT elearning_stats_daily_department_identity_fk
        FOREIGN KEY (department_id, directory_integration_id, directory_provider)
        REFERENCES directory_departments (id, integration_id, provider) ON DELETE RESTRICT,
      CONSTRAINT elearning_stats_daily_identity_chk CHECK (
        org_id = btrim(org_id) AND org_id <> '' AND char_length(org_id) <= 512
        AND directory_provider = btrim(directory_provider)
        AND directory_provider <> '' AND char_length(directory_provider) <= 128
        AND dataset = 'department_overview'
        AND source_version = btrim(source_version)
        AND source_version <> '' AND char_length(source_version) <= 512
        AND payload_digest ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT elearning_stats_daily_period_chk CHECK (
        period_start = (stats_date::timestamp AT TIME ZONE 'UTC')
        AND period_end = ((stats_date + 1)::timestamp AT TIME ZONE 'UTC')
      ),
      CONSTRAINT elearning_stats_daily_threshold_chk CHECK (min_group_size >= 5),
      CONSTRAINT elearning_stats_daily_projection_state_chk CHECK (
        projected_version > 0
        AND (
          last_error IS NULL
          OR (
            last_error ~ '^[A-Z][A-Z0-9_]{1,63}$'
            AND last_error = btrim(last_error)
          )
        )
      ),
      CONSTRAINT elearning_stats_daily_suppression_chk CHECK (
        (
          suppressed
          AND assigned_count IS NULL
          AND completed_count IS NULL
          AND completion_rate IS NULL
          AND credit_average IS NULL
          AND credit_total IS NULL
          AND exam_participant_count IS NULL
          AND learner_count IS NULL
          AND learning_seconds IS NULL
          AND member_count IS NULL
          AND overdue_count IS NULL
        )
        OR (
          NOT suppressed
          AND assigned_count IS NOT NULL
          AND completed_count IS NOT NULL
          AND completion_rate IS NOT NULL
          AND credit_average IS NOT NULL
          AND credit_total IS NOT NULL
          AND exam_participant_count IS NOT NULL
          AND learner_count IS NOT NULL
          AND learning_seconds IS NOT NULL
          AND member_count IS NOT NULL
          AND overdue_count IS NOT NULL
        )
      ),
      CONSTRAINT elearning_stats_daily_metrics_chk CHECK (
        suppressed OR (
          assigned_count >= 0
          AND completed_count >= 0
          AND completed_count <= assigned_count
          AND completion_rate >= 0
          AND completion_rate <= 1
          AND exam_participant_count >= 0
          AND learner_count >= 0
          AND learning_seconds >= 0
          AND member_count >= 0
          AND overdue_count >= 0
          AND overdue_count <= assigned_count
        )
      )
    )
  `.execute(db)
  await sql`
    CREATE INDEX elearning_stats_daily_org_dataset_date_idx
      ON elearning_stats_daily (org_id, dataset, stats_date DESC, department_id)
  `.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const table = await relationPresent(db, ELEARNING_STATS_DAILY_TABLE)
  const index = await relationPresent(db, ELEARNING_STATS_DAILY_READ_INDEX)
  if (table || index) {
    if (!table || !index) drift('partial object set')
    await assertElearningStatsDailySchema(db)
    return
  }
  await createSchema(db)
  await assertElearningStatsDailySchema(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS elearning_stats_daily_org_dataset_date_idx`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_stats_daily`.execute(db)
}
