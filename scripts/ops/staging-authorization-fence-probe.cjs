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

function webhookHoldFunctionShape(definition) {
  const body = definition.match(/\bAS (\$\w*\$)([\s\S]*?)\1/)?.[2]
  if (!body) return null
  const allowed = new Set(['and', 'active', 'begin', 'coalesce', 'else', 'end', 'enabled',
    'errcode', 'exception', 'false', 'if', 'insert', 'is', 'message', 'new', 'not', 'null',
    'old', 'or', 'raise', 'return', 'tg_op', 'then', 'true', 'update', 'using'])
  const tokens = body.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:""|[^"])*"|[a-zA-Z_][a-zA-Z0-9_]*|[^\s]/g) ?? []
  return tokens
    .filter(token => !token.startsWith('--') && !token.startsWith('/*'))
    .map(token => {
      const lower = token.toLowerCase()
      if (token === "'INSERT'" || token === "'UPDATE'") return token
      if (token.startsWith("'")) return '<literal>'
      if (allowed.has(lower) || /^[().,;=:<>!+-]$/.test(token)) return lower
      return '<redacted>'
    })
    .slice(0, 100)
    .join(' ')
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
    const changedTriggerModes = []
    const extraFunctions = []
    if (reference) {
      const triggerKeys = sections[4][1]
      const installedModes = new Map(catalog[4].map(row => [rowKey(row, triggerKeys), row.tgenabled]))
      for (const ref of reference.rows[4]) {
        const key = rowKey(ref, triggerKeys)
        const actual = installedModes.get(key)
        if (actual && actual !== ref.tgenabled) changedTriggerModes.push({ key, expected: ref.tgenabled, actual })
      }
      const functionKeys = sections[7][1]
      const known = new Set(reference.rows[7].map(row => rowKey(row, functionKeys)))
      for (const row of catalog[7].filter(item => !known.has(rowKey(item, functionKeys))).slice(0, 8)) {
        const data = await client.query(`
          SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                   WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') AS extension_member,
                 (SELECT count(*)::int FROM pg_catalog.pg_depend d
                   WHERE d.refclassid = 'pg_catalog.pg_proc'::regclass AND d.refobjid = p.oid) AS dependent_count,
                 (SELECT count(*)::int FROM pg_catalog.pg_trigger t WHERE t.tgfoid = p.oid) AS triggering_count
            FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = $1
             AND pg_catalog.pg_get_function_identity_arguments(p.oid) = $2
        `, [row.proname, row.arguments])
        extraFunctions.push({
          name: /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(row.proname) ? row.proname : null,
          language: row.lanname,
          securityDefiner: row.prosecdef,
          ownerTrusted: row.owner_trusted,
          volatile: row.provolatile,
          argsDigest: sha(row.arguments),
          definitionDigest: sha(row.definition),
          ...data.rows[0],
        })
        if (row.proname === 'ops_hold_webhook_active') {
          const triggers = await client.query(`
            SELECT n.nspname AS schema, c.relname AS relation, t.tgname AS trigger,
                   t.tgenabled AS mode, t.tgtype AS type,
                   t.tgnargs AS argument_count, t.tgqual IS NOT NULL AS has_when_clause
              FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
              JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
             WHERE pn.nspname = 'public' AND p.proname = $1
               AND pg_catalog.pg_get_function_identity_arguments(p.oid) = $2
          `, [row.proname, row.arguments])
          extraFunctions.at(-1).webhookHold = {
            bodyShape: webhookHoldFunctionShape(row.definition),
            fixedSearchPath: row.proconfig?.some(item => item.startsWith('search_path=')) === true,
            triggers: triggers.rows,
          }
        }
      }
    }
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
      changedTriggerModes,
      extraFunctions,
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
