#!/usr/bin/env tsx

import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Pool, type PoolClient } from 'pg'

const OPERATION = 'dingtalk_directory_corp_scope_phase_b_preflight'
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000
const LEGACY_INDEX = 'idx_directory_accounts_provider_external_key'
const SCOPED_INDEXES = [
  'idx_directory_accounts_provider_corp_external_key',
  'idx_directory_accounts_provider_null_corp_external_key',
  'idx_user_external_identities_provider_corp_union',
  'idx_user_external_identities_provider_null_corp_union',
  'idx_user_external_identities_provider_corp_open',
  'idx_user_external_identities_provider_null_corp_open',
] as const
const CORP_CHECKS = [
  'directory_integrations_corp_id_canonical',
  'directory_accounts_corp_id_canonical',
  'user_external_identities_corp_id_canonical',
] as const

type CountText = string

type PreflightCounts = {
  integrations: CountText
  accounts: CountText
  identities: CountText
  invalidIntegrationScope: CountText
  orphanAccounts: CountText
  accountProviderDrift: CountText
  invalidIdentityCorp: CountText
  duplicateAccountScopeGroups: CountText
  duplicateCorpUnionGroups: CountText
  duplicateNullCorpUnionGroups: CountText
  duplicateCorpOpenGroups: CountText
  duplicateNullCorpOpenGroups: CountText
}

export type DirectoryCorpScopePreflightReport = {
  operation: typeof OPERATION
  version: 1
  status: 'PASS' | 'BLOCKED'
  valuesFree: true
  readOnly: true
  schema: {
    requiredTablesPresent: boolean
    integrationCorpNotNull: boolean
    legacyIndexExact: boolean
    scopedIndexCount: CountText
    corpCheckCount: CountText
  }
  counts: PreflightCounts
  blockers: string[]
}

type Queryable = Pick<PoolClient, 'query'>
type Connectable = Pick<Pool, 'connect'>

type SchemaRow = {
  required_tables_present: boolean
  integration_corp_not_null: boolean
  legacy_index_exact: boolean
  scoped_index_count: CountText
  corp_check_count: CountText
}

const ZERO_COUNTS: PreflightCounts = {
  integrations: '0',
  accounts: '0',
  identities: '0',
  invalidIntegrationScope: '0',
  orphanAccounts: '0',
  accountProviderDrift: '0',
  invalidIdentityCorp: '0',
  duplicateAccountScopeGroups: '0',
  duplicateCorpUnionGroups: '0',
  duplicateNullCorpUnionGroups: '0',
  duplicateCorpOpenGroups: '0',
  duplicateNullCorpOpenGroups: '0',
}

function requireCount(value: unknown): CountText {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error('PREFLIGHT_COUNT_INVALID')
  }
  return value
}

function nonZero(value: CountText): boolean {
  return value !== '0'
}

async function readSchema(db: Queryable): Promise<SchemaRow> {
  const result = await db.query<SchemaRow>(
    `
      WITH required_tables AS (
        SELECT count(*)::int AS present
          FROM (VALUES
            ('directory_integrations'),
            ('directory_accounts'),
            ('user_external_identities')
          ) AS required(table_name)
         WHERE to_regclass(required.table_name) IS NOT NULL
      ),
      legacy_shape AS (
        SELECT
          count(*) = 1
          AND bool_and(index_row.indisunique)
          AND bool_and(index_row.indisvalid)
          AND bool_and(index_row.indexprs IS NULL)
          AND bool_and(index_row.indpred IS NULL)
          AND bool_and(index_row.indnkeyatts = 2)
          AND bool_and(index_row.indnatts = 2)
          AND bool_and(ARRAY(
            SELECT attribute.attname
              FROM unnest(index_row.indkey) WITH ORDINALITY AS key(attnum, position)
              JOIN pg_attribute attribute
                ON attribute.attrelid = table_row.oid
               AND attribute.attnum = key.attnum
             WHERE key.position <= index_row.indnkeyatts
             ORDER BY key.position
          )::text[] = ARRAY['provider', 'external_key']::text[]) AS exact
          FROM pg_class index_class
          JOIN pg_index index_row ON index_row.indexrelid = index_class.oid
          JOIN pg_class table_row ON table_row.oid = index_row.indrelid
          JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
         WHERE namespace.nspname = current_schema()
           AND index_class.relname = $1
           AND table_row.relname = 'directory_accounts'
      )
      SELECT
        required_tables.present = 3 AS required_tables_present,
        COALESCE((
          SELECT attribute.attnotnull
            FROM pg_attribute attribute
            JOIN pg_class table_row ON table_row.oid = attribute.attrelid
            JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
           WHERE namespace.nspname = current_schema()
             AND table_row.relname = 'directory_integrations'
             AND attribute.attname = 'corp_id'
             AND attribute.attnum > 0
             AND NOT attribute.attisdropped
        ), false) AS integration_corp_not_null,
        COALESCE(legacy_shape.exact, false) AS legacy_index_exact,
        (
          SELECT count(*)::text
            FROM pg_class index_class
            JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
           WHERE namespace.nspname = current_schema()
             AND index_class.relkind = 'i'
             AND index_class.relname = ANY($2::text[])
        ) AS scoped_index_count,
        (
          SELECT count(*)::text
            FROM pg_constraint constraint_row
            JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
            JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
           WHERE namespace.nspname = current_schema()
             AND constraint_row.contype = 'c'
             AND constraint_row.conname = ANY($3::text[])
        ) AS corp_check_count
        FROM required_tables
        CROSS JOIN legacy_shape
    `,
    [LEGACY_INDEX, [...SCOPED_INDEXES], [...CORP_CHECKS]],
  )
  const row = result.rows[0]
  if (!row) throw new Error('PREFLIGHT_SCHEMA_QUERY_EMPTY')
  return {
    required_tables_present: row.required_tables_present === true,
    integration_corp_not_null: row.integration_corp_not_null === true,
    legacy_index_exact: row.legacy_index_exact === true,
    scoped_index_count: requireCount(row.scoped_index_count),
    corp_check_count: requireCount(row.corp_check_count),
  }
}

async function readCounts(db: Queryable): Promise<PreflightCounts> {
  const result = await db.query<Record<string, unknown>>(
    `
      WITH projected_accounts AS (
        SELECT
          account.provider,
          BTRIM(integration.corp_id) AS corp_id,
          account.external_key
          FROM directory_accounts account
          JOIN directory_integrations integration ON integration.id = account.integration_id
      ),
      projected_identities AS (
        SELECT
          provider,
          NULLIF(BTRIM(corp_id), '') AS corp_id,
          provider_union_id,
          provider_open_id
          FROM user_external_identities
      )
      SELECT
        (SELECT count(*)::text FROM directory_integrations) AS integrations,
        (SELECT count(*)::text FROM directory_accounts) AS accounts,
        (SELECT count(*)::text FROM user_external_identities) AS identities,
        (
          SELECT count(*)::text
            FROM directory_integrations
           WHERE provider IS NULL
              OR provider = ''
              OR corp_id IS NULL
              OR BTRIM(corp_id) !~ '^[!-~]+$'
        ) AS "invalidIntegrationScope",
        (
          SELECT count(*)::text
            FROM directory_accounts account
            LEFT JOIN directory_integrations integration ON integration.id = account.integration_id
           WHERE integration.id IS NULL
        ) AS "orphanAccounts",
        (
          SELECT count(*)::text
            FROM directory_accounts account
            JOIN directory_integrations integration ON integration.id = account.integration_id
           WHERE account.provider IS DISTINCT FROM integration.provider
        ) AS "accountProviderDrift",
        (
          SELECT count(*)::text
            FROM projected_identities
           WHERE corp_id IS NOT NULL
             AND corp_id !~ '^[!-~]+$'
        ) AS "invalidIdentityCorp",
        (
          SELECT count(*)::text
            FROM (
              SELECT provider, corp_id, external_key
                FROM projected_accounts
               WHERE corp_id IS NOT NULL
               GROUP BY provider, corp_id, external_key
              HAVING count(*) > 1
            ) duplicate_groups
        ) AS "duplicateAccountScopeGroups",
        (
          SELECT count(*)::text
            FROM (
              SELECT provider, corp_id, provider_union_id
                FROM projected_identities
               WHERE corp_id IS NOT NULL AND provider_union_id IS NOT NULL
               GROUP BY provider, corp_id, provider_union_id
              HAVING count(*) > 1
            ) duplicate_groups
        ) AS "duplicateCorpUnionGroups",
        (
          SELECT count(*)::text
            FROM (
              SELECT provider, provider_union_id
                FROM projected_identities
               WHERE corp_id IS NULL AND provider_union_id IS NOT NULL
               GROUP BY provider, provider_union_id
              HAVING count(*) > 1
            ) duplicate_groups
        ) AS "duplicateNullCorpUnionGroups",
        (
          SELECT count(*)::text
            FROM (
              SELECT provider, corp_id, provider_open_id
                FROM projected_identities
               WHERE corp_id IS NOT NULL AND provider_open_id IS NOT NULL
               GROUP BY provider, corp_id, provider_open_id
              HAVING count(*) > 1
            ) duplicate_groups
        ) AS "duplicateCorpOpenGroups",
        (
          SELECT count(*)::text
            FROM (
              SELECT provider, provider_open_id
                FROM projected_identities
               WHERE corp_id IS NULL AND provider_open_id IS NOT NULL
               GROUP BY provider, provider_open_id
              HAVING count(*) > 1
            ) duplicate_groups
        ) AS "duplicateNullCorpOpenGroups"
    `,
  )
  const row = result.rows[0]
  if (!row) throw new Error('PREFLIGHT_COUNT_QUERY_EMPTY')
  return Object.fromEntries(
    Object.keys(ZERO_COUNTS).map((key) => [key, requireCount(row[key])]),
  ) as PreflightCounts
}

async function collectDirectoryCorpScopePreflight(
  db: Queryable,
): Promise<DirectoryCorpScopePreflightReport> {
  const schema = await readSchema(db)
  const counts = schema.required_tables_present ? await readCounts(db) : { ...ZERO_COUNTS }
  const blockers: string[] = []

  if (!schema.required_tables_present) blockers.push('required_tables_missing')
  if (!schema.integration_corp_not_null) blockers.push('integration_corp_not_null_missing')
  if (!schema.legacy_index_exact) blockers.push('legacy_index_not_exact')
  if (nonZero(schema.scoped_index_count)) blockers.push('scoped_indexes_already_present')
  if (nonZero(schema.corp_check_count)) blockers.push('corp_checks_already_present')
  for (const [key, value] of Object.entries(counts)) {
    if (
      key !== 'integrations'
      && key !== 'accounts'
      && key !== 'identities'
      && nonZero(value)
    ) {
      blockers.push(key)
    }
  }

  return {
    operation: OPERATION,
    version: 1,
    status: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    valuesFree: true,
    readOnly: true,
    schema: {
      requiredTablesPresent: schema.required_tables_present,
      integrationCorpNotNull: schema.integration_corp_not_null,
      legacyIndexExact: schema.legacy_index_exact,
      scopedIndexCount: schema.scoped_index_count,
      corpCheckCount: schema.corp_check_count,
    },
    counts,
    blockers,
  }
}

export async function runDirectoryCorpScopePreflight(
  pool: Connectable,
  statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS,
): Promise<DirectoryCorpScopePreflightReport> {
  if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1_000 || statementTimeoutMs > 300_000) {
    throw new Error('PREFLIGHT_STATEMENT_TIMEOUT_INVALID')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`)
    const readOnly = await client.query<{ transaction_read_only: string }>(
      'SHOW transaction_read_only',
    )
    if (readOnly.rows[0]?.transaction_read_only !== 'on') {
      throw new Error('PREFLIGHT_TRANSACTION_NOT_READ_ONLY')
    }
    const report = await collectDirectoryCorpScopePreflight(client)
    await client.query('ROLLBACK')
    return report
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

function parseStatementTimeout(argv: string[]): number {
  if (argv.length === 0) return DEFAULT_STATEMENT_TIMEOUT_MS
  if (argv.length !== 2 || argv[0] !== '--statement-timeout-ms') {
    throw new Error('PREFLIGHT_ARGUMENT_INVALID')
  }
  const value = Number(argv[1])
  if (!Number.isSafeInteger(value)) throw new Error('PREFLIGHT_ARGUMENT_INVALID')
  return value
}

function valuesFreeFailure(code: string) {
  return {
    operation: OPERATION,
    version: 1,
    status: 'ERROR',
    valuesFree: true,
    readOnlyVerified: false,
    code,
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.log(JSON.stringify(valuesFreeFailure('PREFLIGHT_DATABASE_URL_REQUIRED')))
    process.exitCode = 1
    return
  }

  let timeoutMs: number
  try {
    timeoutMs = parseStatementTimeout(process.argv.slice(2))
  } catch {
    console.log(JSON.stringify(valuesFreeFailure('PREFLIGHT_ARGUMENT_INVALID')))
    process.exitCode = 1
    return
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: OPERATION,
    connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
    max: 1,
  })
  let output: DirectoryCorpScopePreflightReport | ReturnType<typeof valuesFreeFailure>
  let exitCode: 0 | 1 | 2
  try {
    const report = await runDirectoryCorpScopePreflight(pool, timeoutMs)
    output = report
    exitCode = report.status === 'PASS' ? 0 : 2
  } catch {
    output = valuesFreeFailure('PREFLIGHT_QUERY_FAILED')
    exitCode = 1
  } finally {
    try {
      await pool.end()
    } catch {
      output = valuesFreeFailure('PREFLIGHT_POOL_CLOSE_FAILED')
      exitCode = 1
    }
  }
  console.log(JSON.stringify(output, null, 2))
  process.exitCode = exitCode
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  void main().catch(() => {
    console.log(JSON.stringify(valuesFreeFailure('PREFLIGHT_UNEXPECTED_FAILURE')))
    process.exitCode = 1
  })
}
