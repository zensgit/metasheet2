const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { gunzipSync } = require('node:zlib')

const backend = '/app/packages/core-backend'
const appRequire = createRequire(`${backend}/package.json`)
const { Client } = appRequire('pg')
const {
  AUTHORIZATION_OPERATION_FENCE_TABLES,
  inspectAuthorizationOperationSchema,
  isSupportedAuthorizationOperationSchema,
} = appRequire('./dist/src/admin/authorization-operation-fence.js')

const sections = [
  ['tables', ['relname']],
  ['columns', ['relname', 'attname']],
  ['constraints', ['source_schema', 'source', 'conname']],
  ['indexes', ['table_name', 'index_name']],
  ['triggers', ['relname', 'tgname']],
  ['rules', ['relname', 'rulename']],
  ['policies', ['relname', 'polname']],
  ['functions', ['nspname', 'proname', 'arguments']],
]

function sha(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function rowKey(row, fields) {
  return fields.map((field) => row[field]).join('.')
}

function compareSection(live, reference, fields) {
  const liveRows = new Map(live.map(row => [rowKey(row, fields), row]))
  const referenceRows = new Map(reference.map(row => [rowKey(row, fields), row]))
  const missing = []
  const changed = []
  for (const [key, expected] of referenceRows) {
    const actual = liveRows.get(key)
    if (!actual) {
      missing.push(key)
    } else {
      const differences = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
        .filter(field => sha(expected[field] ?? null) !== sha(actual[field] ?? null))
      if (differences.length > 0) changed.push({ key, fields: differences })
    }
  }
  const extra = [...liveRows.keys()].filter(key => !referenceRows.has(key))
  return {
    count: live.length,
    referenceCount: reference.length,
    digest: sha(live),
    sameOrderedDigest: sha(live) === sha(reference),
    missingCount: missing.length,
    changedCount: changed.length,
    extraCount: extra.length,
    missing: missing.slice(0, 16),
    changed: changed.slice(0, 16),
    extraKeyDigests: extra.slice(0, 16).map(sha),
  }
}

async function run() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL_MISSING')
  const expectedAddresses = (process.env.STAGING_FENCE_EXPECTED_DB_ADDRESSES ?? '').split(',').filter(Boolean)
  if (!expectedAddresses.length) throw new Error('STAGING_DB_CONTAINER_ADDRESS_MISSING')
  const client = new Client({
    connectionString,
    application_name: 'staging-authorization-fence-readonly',
    connectionTimeoutMillis: 5000,
  })
  await client.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '500ms'")
    const start = await client.query(
      "SELECT current_schema() = 'public' AS schema_public, current_setting('transaction_read_only') = 'on' AS read_only, host(inet_server_addr()) = ANY($1::text[]) AS staging_database",
      [expectedAddresses],
    )
    if (start.rows[0]?.read_only !== true) throw new Error('NOT_READ_ONLY')
    if (start.rows[0]?.staging_database !== true) throw new Error('NOT_STAGING_DATABASE')
    await client.query("SET LOCAL search_path TO pg_catalog, public, pg_temp")
    const snapshots = []
    const result = await inspectAuthorizationOperationSchema(async (sql, params) => {
      const queryResult = await client.query(sql, params)
      snapshots.push(queryResult.rows)
      return queryResult
    })
    const [databaseRows, ...catalog] = snapshots
    if (catalog.length !== sections.length) throw new Error('UNEXPECTED_CATALOG_SHAPE')
    const database = databaseRows[0]
    const initialSchemaPublic = start.rows[0]?.schema_public === true
    const supported = isSupportedAuthorizationOperationSchema(result)
    const major = database.version
    const reference = [14, 15, 16, 17].includes(major)
      ? JSON.parse(gunzipSync(readFileSync(`${backend}/tests/fixtures/authorization-operation-catalog/pg${major}.json.gz`)))
      : null
    const fence = initialSchemaPublic && supported
    const output = {
      buildCommit: /^[0-9a-f]{40}$/.test(process.env.METASHEET_BUILD_COMMIT ?? '')
        ? process.env.METASHEET_BUILD_COMMIT
        : null,
      readOnly: true,
      initialSchemaPublic,
      database,
      tableCountExpected: AUTHORIZATION_OPERATION_FENCE_TABLES.length,
      ...result,
      profileSupported: supported,
      previewFenceReady: fence,
      exactDepartmentEnabled: process.env.DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED === 'true',
      activationEnabled: process.env.DELEGATED_SCOPE_ACTIVATION_ENABLED === 'true',
      differences: reference && Object.fromEntries(sections.map(([section, fields], index) =>
        [section, compareSection(catalog[index], reference.rows[index], fields)])),
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    await client.end()
  }
}

run().catch(error => {
  const reason = /^[A-Z0-9_]+$/.test(error.message ?? '') ? error.message : undefined
  const sqlState = /^[A-Z0-9]{5}$/.test(error.code ?? '') ? error.code : undefined
  process.stderr.write(`${JSON.stringify({ error: 'STAGING_AUTHORIZATION_FENCE_PROBE_FAILED', reason, sqlState })}\n`)
  process.exitCode = 1
})
