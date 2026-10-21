'use strict'

// W5-M / CR-08 — pins the PR-1 acceptance line from
// docs/integration-consolidation-minimal-plan-20260901.md §5 ("PR-1 验收"), verbatim:
//
//   "新旧读取路径的 schema、对象列表和只读查询结果一致。"
//
// This suite is the first test to actually DRIVE both read paths (canonical `connection_id`
// vs legacy `config.dataSourceId` + `legacy_connection_fallback_eligible=true`) for the SAME
// underlying data_sources connection, through the real `connection-resolver.cjs` ->
// `external-systems.cjs#getExternalSystemForAdapter` -> `contracts.cjs#createAdapterRegistry` ->
// `data-source-sql-readonly-source-adapter.cjs` chain, and assert the two paths produce
// byte-identical `listObjects()` / `getSchema()` / `read()` results.
//
// Design + fixture rationale: docs/development/pr1-canonical-legacy-read-equivalence-design-20260916.md
// Verification (mutation kill, test-chain run): docs/development/pr1-canonical-legacy-read-equivalence-verification-20260916.md
//
// Existing coverage checked first (nothing duplicated):
//   - __tests__/connection-resolver.test.cjs exercises `resolve()`/`resolveSealedSqlServer()`
//     policy branches (tenant/type/legacy-marker checks) in isolation, but never resolves a
//     canonical AND a legacy binding that point at the SAME connection and diffs their outputs,
//     and never reaches an adapter's listObjects/getSchema/read.
//   - __tests__/external-systems.test.cjs exercises `getExternalSystemForAdapter` for a single
//     canonical binding (search `canonicalAdapterSystem`) but has no legacy-fallback counterpart
//     in the same test, and does not call an adapter factory afterwards.
//   - __tests__/integration-connection-binding-migration.test.cjs is pure migration-SQL-text
//     assertions; it proves the schema, not runtime read equivalence.
// This file is therefore new, not an extension of an existing one.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  createExternalSystemRegistry,
} = require(path.join(__dirname, '..', 'lib', 'external-systems.cjs'))
const { createConnectionResolver } = require(path.join(__dirname, '..', 'lib', 'connection-resolver.cjs'))
const { createAdapterRegistry } = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))
const {
  createDataSourceSqlReadonlySourceAdapterFactory,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'data-source-sql-readonly-source-adapter.cjs'))

const TENANT_ID = 'tenant_1'
const PRINCIPAL = 'owner_1'

// --- fake host "DataSourceManager" -----------------------------------------------------------
// In production a single `context.api.dataSources` facade implements BOTH the connection-registry
// surface the resolver calls (`resolveConnectionRegistration`) AND the read-execution surface the
// `data-source:sql-readonly` adapter calls (`test`/`getSchema`/`getTableInfo`/`select`) — see
// plugins/plugin-integration-core/index.cjs:305-314 (facade wiring) and
// lib/adapters/data-source-sql-readonly-source-adapter.cjs:305-320 (`getDataSourcesApi`). This
// fake reproduces that single-object shape rather than splitting it into two mocks, so a
// resolved `dataSourceId` is guaranteed to route the adapter's reads to the SAME fixture data the
// resolver just authorized.
function createFakeDataSourceManager() {
  const connections = {
    ds_alpha: {
      registration: { tenantId: TENANT_ID, type: 'sqlserver', scopeKind: 'legacy_private' },
      schema: {
        tables: [{
          name: 'items',
          schema: 'dbo',
          columns: [
            { name: 'id', type: 'int', nullable: false },
            { name: 'name', type: 'varchar', nullable: true },
          ],
        }],
        views: [],
      },
      tableInfo: {
        items: {
          columns: [
            { name: 'id', type: 'int', nullable: false },
            { name: 'name', type: 'varchar', nullable: true },
          ],
        },
      },
      rows: { items: [{ id: 1, name: 'Alpha-1' }, { id: 2, name: 'Alpha-2' }] },
    },
    ds_beta: {
      registration: { tenantId: TENANT_ID, type: 'sqlserver', scopeKind: 'legacy_private' },
      // Deliberately a DIFFERENT shape from ds_alpha (extra column, extra view) — not just
      // different row content — so the reverse control below can diff listObjects/getSchema too,
      // not only read().
      schema: {
        tables: [{
          name: 'items',
          schema: 'dbo',
          columns: [
            { name: 'id', type: 'int', nullable: false },
            { name: 'name', type: 'varchar', nullable: true },
            { name: 'note', type: 'varchar', nullable: true },
          ],
        }],
        views: [{
          name: 'items_view',
          schema: 'dbo',
          columns: [{ name: 'id', type: 'int', nullable: false }],
        }],
      },
      tableInfo: {
        items: {
          columns: [
            { name: 'id', type: 'int', nullable: false },
            { name: 'name', type: 'varchar', nullable: true },
            { name: 'note', type: 'varchar', nullable: true },
          ],
        },
      },
      // Deliberately different row content from ds_alpha — this is what the reverse control
      // (different data_source -> different read result) depends on.
      rows: { items: [{ id: 9, name: 'Beta-9', note: 'beta-note' }] },
    },
  }

  function entryOrThrow(dataSourceId) {
    const entry = connections[dataSourceId]
    if (!entry) throw new Error(`fake data source manager: unknown connection ${dataSourceId}`)
    return entry
  }

  const calls = {
    resolveConnectionRegistration: [],
    test: [],
    getSchema: [],
    getTableInfo: [],
    select: [],
  }

  return {
    calls,
    async resolveConnectionRegistration(id, context) {
      const entry = entryOrThrow(id)
      // A fresh object per call (not a shared reference) so a deepEqual comparison across the
      // canonical and legacy calls proves field-by-field equality, not reference identity.
      const registration = { id, ...entry.registration }
      calls.resolveConnectionRegistration.push({ id, context, registration })
      return registration
    },
    async test(dataSourceId, principal) {
      calls.test.push({ dataSourceId, principal })
      return { success: Boolean(connections[dataSourceId]) }
    },
    async getSchema(dataSourceId, principal, schema) {
      const entry = entryOrThrow(dataSourceId)
      calls.getSchema.push({ dataSourceId, principal, schema })
      return JSON.parse(JSON.stringify(entry.schema))
    },
    async getTableInfo(dataSourceId, table, principal, schema) {
      const entry = entryOrThrow(dataSourceId)
      const info = entry.tableInfo[table]
      if (!info) throw new Error(`fake data source manager: unknown table ${table}`)
      calls.getTableInfo.push({ dataSourceId, table, principal, schema })
      return JSON.parse(JSON.stringify(info))
    },
    async select(dataSourceId, object, options, principal, armed) {
      const entry = entryOrThrow(dataSourceId)
      calls.select.push({ dataSourceId, object, options, principal, armed })
      const table = object.includes('.') ? object.slice(object.lastIndexOf('.') + 1) : object
      const rows = entry.rows[table] || []
      return { data: JSON.parse(JSON.stringify(rows)) }
    },
  }
}

// --- minimal db/credentialStore fakes --------------------------------------------------------
// Only `selectOne` is exercised by `getExternalSystemForAdapter` (read path); the other methods
// are stubbed to THROW if ever called, so an accidental write in this read-only suite fails loud
// instead of silently mutating fixture state.
function createReadOnlyFakeDb(rows) {
  function matchesWhere(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }
  function unexpectedWrite(name) {
    return async () => {
      throw new Error(`this read-equivalence fixture must not call db.${name}`)
    }
  }
  return {
    async selectOne(table, where) {
      return rows.find((row) => matchesWhere(row, where)) || null
    },
    insertOne: unexpectedWrite('insertOne'),
    updateRow: unexpectedWrite('updateRow'),
    select: unexpectedWrite('select'),
    deleteRows: unexpectedWrite('deleteRows'),
    countRows: unexpectedWrite('countRows'),
  }
}

function createUnusedCredentialStore() {
  return {
    async encrypt() { throw new Error('credentialStore.encrypt must not be called by this read-only fixture') },
    async decrypt() { throw new Error('credentialStore.decrypt must not be called by this read-only fixture') },
    async fingerprint() { throw new Error('credentialStore.fingerprint must not be called by this read-only fixture') },
  }
}

// --- fixture rows: two bindings referencing the SAME connection (ds_alpha) via the two
// different read paths, plus a ds_beta pair for the reverse control ---------------------------
function bindingRow(overrides) {
  return {
    tenant_id: TENANT_ID,
    workspace_id: null,
    project_id: null,
    kind: 'data-source:sql-readonly',
    role: 'source',
    capabilities: {},
    status: 'active',
    last_tested_at: null,
    last_error: null,
    credentials_encrypted: null,
    created_at: '2026-09-05T00:00:00.000Z',
    updated_at: '2026-09-05T00:00:00.000Z',
    ...overrides,
  }
}

const ROWS = [
  bindingRow({
    id: 'sys_canonical_alpha',
    name: 'alpha-canonical',
    config: { schema: 'dbo' },
    connection_id: 'ds_alpha',
    legacy_connection_fallback_eligible: false,
  }),
  bindingRow({
    id: 'sys_legacy_alpha',
    name: 'alpha-legacy',
    config: { dataSourceId: 'ds_alpha', schema: 'dbo' },
    connection_id: null,
    legacy_connection_fallback_eligible: true,
    // Pre-cutover creation date — required by the resolver's legacy-fallback eligibility check
    // (`hasValidCreatedAt`); any parseable date satisfies it, the resolver does not compare
    // against a wall-clock cutover constant (see integration-connection-binding-migration.test.cjs).
    created_at: '2026-08-15T00:00:00.000Z',
    updated_at: '2026-08-15T00:00:00.000Z',
  }),
  bindingRow({
    id: 'sys_canonical_beta',
    name: 'beta-canonical',
    config: { schema: 'dbo' },
    connection_id: 'ds_beta',
    legacy_connection_fallback_eligible: false,
  }),
  bindingRow({
    id: 'sys_legacy_beta',
    name: 'beta-legacy',
    config: { dataSourceId: 'ds_beta', schema: 'dbo' },
    connection_id: null,
    legacy_connection_fallback_eligible: true,
    created_at: '2026-08-15T00:00:00.000Z',
    updated_at: '2026-08-15T00:00:00.000Z',
  }),
]

const READ_CONTEXT = { tenantId: TENANT_ID, workspaceId: null, principal: PRINCIPAL, runAs: 'user' }

async function resolveAndCreateAdapter({ registry, adapterRegistry, id }) {
  const resolved = await registry.getExternalSystemForAdapter({ ...READ_CONTEXT, id })
  const adapter = adapterRegistry.createAdapter(resolved, { principal: PRINCIPAL })
  return { resolved, adapter }
}

async function readAll(adapter) {
  const objects = await adapter.listObjects()
  const schema = await adapter.getSchema({ object: 'dbo.items' })
  const read = await adapter.read({ object: 'dbo.items', limit: 10 })
  return { objects, schema, read }
}

async function main() {
  const fakeDataSourceManager = createFakeDataSourceManager()
  const db = createReadOnlyFakeDb(ROWS)
  const credentialStore = createUnusedCredentialStore()
  const connectionResolver = createConnectionResolver({ facade: fakeDataSourceManager })
  const registry = createExternalSystemRegistry({ db, credentialStore, connectionResolver })

  const hostContext = { api: { dataSources: fakeDataSourceManager } }
  const adapterRegistry = createAdapterRegistry({}).registerAdapter(
    'data-source:sql-readonly',
    createDataSourceSqlReadonlySourceAdapterFactory({ context: hostContext }),
  )

  // --- 1. Canonical and legacy bindings resolve the SAME connection reference ------------------
  const { resolved: canonicalAlpha, adapter: canonicalAlphaAdapter } = await resolveAndCreateAdapter({
    registry, adapterRegistry, id: 'sys_canonical_alpha',
  })
  const { resolved: legacyAlpha, adapter: legacyAlphaAdapter } = await resolveAndCreateAdapter({
    registry, adapterRegistry, id: 'sys_legacy_alpha',
  })

  assert.equal(canonicalAlpha.config.dataSourceId, 'ds_alpha')
  assert.equal(legacyAlpha.config.dataSourceId, 'ds_alpha')
  // "Adapter 收到的 config 相等" — the whole adapter-visible config object, not just dataSourceId.
  assert.deepEqual(canonicalAlpha.config, legacyAlpha.config)

  // "解析出的连接引用（dataSourceId/tenant/scope）逐字段相等" — diff the host facade's own
  // registration objects returned for each path's connection lookup (fresh objects, see above).
  const registrationCalls = fakeDataSourceManager.calls.resolveConnectionRegistration
    .filter((call) => call.id === 'ds_alpha')
  assert.equal(registrationCalls.length, 2, 'both paths must consult the connection registry exactly once each')
  const [canonicalRegistration, legacyRegistration] = registrationCalls.map((call) => call.registration)
  assert.deepEqual(canonicalRegistration, legacyRegistration)
  assert.equal(canonicalRegistration.tenantId, TENANT_ID)
  assert.equal(canonicalRegistration.scopeKind, 'legacy_private')

  // --- 2. listObjects / getSchema / read are byte-identical across the two paths ---------------
  const canonicalAlphaResult = await readAll(canonicalAlphaAdapter)
  const legacyAlphaResult = await readAll(legacyAlphaAdapter)
  assert.deepEqual(canonicalAlphaResult.objects, legacyAlphaResult.objects, 'listObjects must match')
  assert.deepEqual(canonicalAlphaResult.schema, legacyAlphaResult.schema, 'getSchema must match')
  assert.deepEqual(canonicalAlphaResult.read, legacyAlphaResult.read, 'read must match')
  // Sanity: the fixture actually returned real data, not two empty/undefined results that would
  // make the equality assertions above vacuously true.
  assert.equal(canonicalAlphaResult.objects.length, 1)
  assert.equal(canonicalAlphaResult.read.records.length, 2)
  assert.equal(canonicalAlphaResult.read.records[0].name, 'Alpha-1')

  // --- 3. Reverse control: two DIFFERENT underlying data sources must NOT read the same ---------
  // This is the falsification check. If the fixture (or a future refactor) accidentally made
  // every adapter call return constant data regardless of dataSourceId, section 2's equality
  // assertions would still pass — this section is what would catch that.
  const { resolved: canonicalBeta, adapter: canonicalBetaAdapter } = await resolveAndCreateAdapter({
    registry, adapterRegistry, id: 'sys_canonical_beta',
  })
  const { resolved: legacyBeta, adapter: legacyBetaAdapter } = await resolveAndCreateAdapter({
    registry, adapterRegistry, id: 'sys_legacy_beta',
  })
  assert.equal(canonicalBeta.config.dataSourceId, 'ds_beta')
  assert.equal(legacyBeta.config.dataSourceId, 'ds_beta')
  assert.notEqual(canonicalBeta.config.dataSourceId, canonicalAlpha.config.dataSourceId)

  const canonicalBetaResult = await readAll(canonicalBetaAdapter)
  const legacyBetaResult = await readAll(legacyBetaAdapter)
  // The two paths still agree WITH EACH OTHER for ds_beta (equivalence holds for a second,
  // independent connection, not just the fixture's first row)...
  assert.deepEqual(canonicalBetaResult.read, legacyBetaResult.read)
  // ...but ds_alpha and ds_beta results must differ from each other on every one of the three
  // read calls, proving section 2's equality is driven by real, distinguishable read paths
  // rather than a fixture that ignores its dataSourceId input.
  assert.notDeepEqual(canonicalBetaResult.objects, canonicalAlphaResult.objects,
    'reverse control: listObjects must differ for different data_source connections')
  assert.notDeepEqual(canonicalBetaResult.schema, canonicalAlphaResult.schema,
    'reverse control: getSchema must differ for different data_source connections')
  assert.notDeepEqual(canonicalBetaResult.read, canonicalAlphaResult.read,
    'reverse control: read must differ for different data_source connections')

  console.log('✓ pr1-canonical-legacy-read-equivalence tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
