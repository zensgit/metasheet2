import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const USER_ORGS_TABLE = 'user_orgs'
const USER_ORGS_ORG_INDEX = 'idx_user_orgs_org'

type ColumnShape = {
  column_name: string
  data_type: string
  is_nullable: string
}

type PrimaryKeyShape = {
  columns: string[]
}

type IndexShape = {
  columns: string[]
  table_name: string
  unfiltered: boolean
}

const EXPECTED_COLUMNS: ColumnShape[] = [
  { column_name: 'user_id', data_type: 'text', is_nullable: 'NO' },
  { column_name: 'org_id', data_type: 'text', is_nullable: 'NO' },
  { column_name: 'is_active', data_type: 'boolean', is_nullable: 'NO' },
  {
    column_name: 'created_at',
    data_type: 'timestamp with time zone',
    is_nullable: 'NO',
  },
]

function sameColumns(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length
    && actual.every((column, index) => column === expected[index])
}

async function assertCanonicalColumns(db: Kysely<unknown>): Promise<void> {
  const result = await sql<ColumnShape>`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ${USER_ORGS_TABLE}
       AND column_name IN ('user_id', 'org_id', 'is_active', 'created_at')
     ORDER BY ordinal_position
  `.execute(db)

  const actual = result.rows.map((row) => ({
    column_name: row.column_name,
    data_type: row.data_type,
    is_nullable: row.is_nullable,
  }))
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_COLUMNS)) {
    throw new Error('USER_ORGS_SCHEMA_DRIFT')
  }
}

async function ensureCanonicalPrimaryKey(db: Kysely<unknown>): Promise<void> {
  const result = await sql<PrimaryKeyShape>`
    SELECT array_agg(attribute_info.attname ORDER BY key_column.ordinality)::text[] AS columns
      FROM pg_constraint constraint_info
      JOIN LATERAL unnest(constraint_info.conkey) WITH ORDINALITY
        AS key_column(attnum, ordinality) ON TRUE
      JOIN pg_attribute attribute_info
        ON attribute_info.attrelid = constraint_info.conrelid
       AND attribute_info.attnum = key_column.attnum
     WHERE constraint_info.conrelid = 'user_orgs'::regclass
       AND constraint_info.contype = 'p'
     GROUP BY constraint_info.oid
  `.execute(db)

  if (result.rows.length === 0) {
    await sql`
      ALTER TABLE user_orgs
        ADD CONSTRAINT user_orgs_pkey PRIMARY KEY (user_id, org_id)
    `.execute(db)
    return
  }
  if (
    result.rows.length !== 1
    || !sameColumns(result.rows[0]?.columns ?? [], ['user_id', 'org_id'])
  ) {
    throw new Error('USER_ORGS_SCHEMA_DRIFT')
  }
}

async function ensureCanonicalOrgIndex(db: Kysely<unknown>): Promise<void> {
  const existing = await sql<IndexShape>`
    SELECT table_info.relname AS table_name,
           array_agg(attribute_info.attname ORDER BY key_column.ordinality)::text[] AS columns,
           index_info.indpred IS NULL AS unfiltered
      FROM pg_class index_class
      JOIN pg_namespace namespace_info
        ON namespace_info.oid = index_class.relnamespace
      JOIN pg_index index_info ON index_info.indexrelid = index_class.oid
      JOIN pg_class table_info ON table_info.oid = index_info.indrelid
      JOIN LATERAL unnest(index_info.indkey) WITH ORDINALITY
        AS key_column(attnum, ordinality) ON TRUE
      JOIN pg_attribute attribute_info
        ON attribute_info.attrelid = table_info.oid
       AND attribute_info.attnum = key_column.attnum
     WHERE namespace_info.nspname = current_schema()
       AND index_class.relname = ${USER_ORGS_ORG_INDEX}
     GROUP BY table_info.relname, index_info.indpred
  `.execute(db)

  if (existing.rows.length === 0) {
    await sql`CREATE INDEX idx_user_orgs_org ON user_orgs (org_id)`.execute(db)
    return
  }
  const index = existing.rows[0]
  if (
    existing.rows.length !== 1
    || index?.table_name !== USER_ORGS_TABLE
    || index.unfiltered !== true
    || !sameColumns(index.columns, ['org_id'])
  ) {
    throw new Error('USER_ORGS_SCHEMA_DRIFT')
  }
}

/**
 * Ensure the single canonical membership substrate needed by org-scoped FKs.
 * Data backfills deliberately remain in their owning migration because replay
 * lanes may carry a legacy users table without the modern is_active column.
 */
export async function ensureCanonicalUserOrgsTable(
  db: Kysely<unknown>,
): Promise<void> {
  await db.schema
    .createTable(USER_ORGS_TABLE)
    .ifNotExists()
    .addColumn('user_id', 'text', (column) => column.notNull())
    .addColumn('org_id', 'text', (column) => column.notNull())
    .addColumn('is_active', 'boolean', (column) => column.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (column) => column.defaultTo(sql`now()`).notNull())
    .execute()

  await assertCanonicalColumns(db)
  await ensureCanonicalPrimaryKey(db)
  await ensureCanonicalOrgIndex(db)
}
