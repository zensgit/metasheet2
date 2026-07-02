'use strict'

// External-API read self-service S2-c — content-keyed config persistence + values-free audit.
// Mock db only — no network, no adapter, no route, no write path.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  ReadSourceConfigValidationError,
  ReadSourceConfigNotFoundError,
  ReadSourceConfigConflictError,
  ReadSourceConfigNotApprovedError,
  createReadSourceConfigStore,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'read-source-config-store.cjs'))

const CONFIG_TABLE = 'integration_read_source_configs'
const AUDIT_TABLE = 'integration_read_source_config_audit'

function createMockDb() {
  const tables = { [CONFIG_TABLE]: [], [AUDIT_TABLE]: [] }
  const calls = []

  function matchesWhere(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }

  return {
    tables,
    calls,
    async selectOne(table, where) {
      calls.push(['selectOne', table, { ...where }])
      return tables[table].find((row) => matchesWhere(row, where)) || null
    },
    async insertOne(table, row) {
      calls.push(['insertOne', table, JSON.parse(JSON.stringify(row))])
      const stored = {
        ...row,
        created_at: row.created_at || '2026-07-01T00:00:00.000Z',
        updated_at: row.updated_at || '2026-07-01T00:00:00.000Z',
      }
      tables[table].push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      calls.push(['updateRow', table, { ...set }, { ...where }])
      const row = tables[table].find((candidate) => matchesWhere(candidate, where))
      if (!row) return []
      Object.assign(row, set, { updated_at: '2026-07-01T01:00:00.000Z' })
      return [row]
    },
    async select(table, options = {}) {
      calls.push(['select', table, JSON.parse(JSON.stringify(options))])
      const filtered = tables[table].filter((row) => matchesWhere(row, options.where || {}))
      return filtered.slice(options.offset || 0, (options.offset || 0) + (options.limit || 1000))
    },
  }
}

// Distinctive strings so leak scans are meaningful: the audit trail must never contain any of them.
const DISTINCTIVE = {
  readPath: '/K3API/Distinctive/GetDetail',
  container: 'DistinctiveData',
  keyField: 'FDistinctiveNumber',
  fieldSource: 'FDistinctiveName',
  fieldTarget: 'distinctive_target',
}

function validConfig(overrides = {}) {
  return {
    version: 1,
    systemId: 'sys_1',
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material',
    mode: 'single_record',
    readPath: DISTINCTIVE.readPath,
    readMethod: 'POST',
    operations: ['read'],
    keyField: DISTINCTIVE.keyField,
    containerPaths: [DISTINCTIVE.container],
    fieldMap: [{ source: DISTINCTIVE.fieldSource, target: DISTINCTIVE.fieldTarget }],
    ...overrides,
  }
}

function newStore() {
  const db = createMockDb()
  let seq = 0
  const store = createReadSourceConfigStore({ db, idGenerator: () => `id_${++seq}` })
  return { db, store }
}

const SCOPE = { tenantId: 'tenant_1', workspaceId: 'workspace_1' }

async function testInvalidConfigRejectedValuesFree() {
  const { db, store } = newStore()
  await assert.rejects(
    () => store.saveVersion({ ...SCOPE, config: validConfig({ readPath: 'https://evil.example.com/x' }), actor: 'consultant_1' }),
    (error) => {
      assert.ok(error instanceof ReadSourceConfigValidationError)
      assert.ok(Array.isArray(error.details.errors) && error.details.errors.length > 0)
      const text = JSON.stringify({ message: error.message, details: error.details })
      assert.ok(!text.includes('evil.example.com'), 'validation error must not echo the submitted endpoint')
      return true
    },
  )
  // Inline credential end-to-end: S1 rejects it, nothing reaches either table.
  await assert.rejects(
    () => store.saveVersion({ ...SCOPE, config: validConfig({ bearerToken: 'sk-super-secret' }), actor: 'consultant_1' }),
    (error) => {
      assert.ok(error instanceof ReadSourceConfigValidationError)
      assert.ok(!JSON.stringify(error.details).includes('sk-super-secret'))
      return true
    },
  )
  assert.equal(db.tables[CONFIG_TABLE].length, 0, 'invalid config never reaches the config table')
  assert.equal(db.tables[AUDIT_TABLE].length, 0, 'invalid config never reaches the audit table')
}

async function testSaveStoresNormalizedOnlyAndMintsDraft() {
  const { db, store } = newStore()
  // Untrimmed raw input: storage must hold the S1 NORMALIZED structure, not the raw form.
  const saved = await store.saveVersion({
    ...SCOPE,
    config: validConfig({ systemId: ' sys_1 ', object: ' material ' }),
    actor: 'consultant_1',
  })
  assert.equal(saved.reused, false)
  assert.equal(saved.version, 1)
  assert.equal(saved.status, 'draft')
  assert.equal(saved.systemId, 'sys_1')
  assert.equal(saved.object, 'material')
  assert.match(saved.contentKey, /^[0-9a-f]{64}$/)
  const row = db.tables[CONFIG_TABLE][0]
  assert.equal(row.config.systemId, 'sys_1', 'stored config is the normalized (trimmed) structure')
  assert.deepEqual(row.config.operations, ['read'])
  assert.equal(row.created_by, 'consultant_1')
}

async function testContentKeyIdempotency() {
  const { db, store } = newStore()
  const first = await store.saveVersion({ ...SCOPE, config: validConfig(), actor: 'consultant_1' })
  // Same content, different key order + whitespace → SAME version, reused, no new config row.
  const reordered = Object.fromEntries(Object.entries(validConfig({ systemId: ' sys_1 ' })).reverse())
  const second = await store.saveVersion({ ...SCOPE, config: reordered, actor: 'consultant_2' })
  assert.equal(second.reused, true)
  assert.equal(second.version, 1)
  assert.equal(second.id, first.id)
  assert.equal(db.tables[CONFIG_TABLE].length, 1, 'idempotent save is a no-op on the config table')
  assert.deepEqual(db.tables[AUDIT_TABLE].map((row) => row.action), ['save_version', 'reuse_version'])

  // Changed content → next version in the family.
  const third = await store.saveVersion({ ...SCOPE, config: validConfig({ readMethod: 'GET' }), actor: 'consultant_1' })
  assert.equal(third.reused, false)
  assert.equal(third.version, 2)
  assert.equal(db.tables[CONFIG_TABLE].length, 2)
}

async function testFamilyIsolation() {
  const { store } = newStore()
  const a = await store.saveVersion({ ...SCOPE, config: validConfig(), actor: 'c' })
  const b = await store.saveVersion({ ...SCOPE, config: validConfig({ systemId: 'sys_2' }), actor: 'c' })
  const c = await store.saveVersion({ ...SCOPE, config: validConfig({ object: 'customer' }), actor: 'c' })
  const d = await store.saveVersion({ ...SCOPE, config: validConfig({ mode: 'list_page', keyField: undefined, fieldMap: undefined }), actor: 'c' })
  for (const saved of [a, b, c, d]) {
    assert.equal(saved.version, 1, 'each (systemId, object, mode) family mints its own v1')
  }
}

async function testStatusTransitionsFailClosed() {
  const { store } = newStore()
  const saved = await store.saveVersion({ ...SCOPE, config: validConfig(), actor: 'c' })

  // retire before approve → conflict (only approved → retired).
  await assert.rejects(
    () => store.retire({ ...SCOPE, id: saved.id, actor: 'c' }),
    (error) => error instanceof ReadSourceConfigConflictError,
  )
  // runtime lookup of a draft → fail-closed NotApproved.
  await assert.rejects(
    () => store.getForRuntime({ ...SCOPE, id: saved.id }),
    (error) => error instanceof ReadSourceConfigNotApprovedError,
  )

  const approved = await store.approve({ ...SCOPE, id: saved.id, actor: 'approver_1' })
  assert.equal(approved.status, 'approved')
  // double-approve → conflict (draft → approved only).
  await assert.rejects(
    () => store.approve({ ...SCOPE, id: saved.id, actor: 'approver_1' }),
    (error) => error instanceof ReadSourceConfigConflictError,
  )
  const runtime = await store.getForRuntime({ ...SCOPE, id: saved.id })
  assert.equal(runtime.status, 'approved')

  const retired = await store.retire({ ...SCOPE, id: saved.id, actor: 'approver_1' })
  assert.equal(retired.status, 'retired')
  // retired is terminal: no re-approve, no runtime consumption.
  await assert.rejects(
    () => store.approve({ ...SCOPE, id: saved.id, actor: 'approver_1' }),
    (error) => error instanceof ReadSourceConfigConflictError,
  )
  await assert.rejects(
    () => store.getForRuntime({ ...SCOPE, id: saved.id }),
    (error) => error instanceof ReadSourceConfigNotApprovedError,
  )
}

async function testScopingAndNotFound() {
  const { store } = newStore()
  const saved = await store.saveVersion({ ...SCOPE, config: validConfig(), actor: 'c' })
  await assert.rejects(
    () => store.get({ tenantId: 'tenant_2', workspaceId: 'workspace_1', id: saved.id }),
    (error) => error instanceof ReadSourceConfigNotFoundError,
  )
  await assert.rejects(
    () => store.get({ ...SCOPE, id: 'missing' }),
    (error) => error instanceof ReadSourceConfigNotFoundError,
  )
  const listed = await store.list({ ...SCOPE, systemId: 'sys_1' })
  assert.equal(listed.length, 1)
  const other = await store.list({ tenantId: 'tenant_2', workspaceId: 'workspace_1' })
  assert.equal(other.length, 0, 'list is tenant-scoped')
  // status filter is enum-strict — an unknown status fail-closes rather than silently matching all.
  await assert.rejects(
    () => store.list({ ...SCOPE, status: 'everything' }),
    (error) => error instanceof ReadSourceConfigValidationError,
  )
}

async function testAuditTrailIsValuesFree() {
  const { db, store } = newStore()
  const saved = await store.saveVersion({ ...SCOPE, config: validConfig(), actor: 'consultant_1' })
  await store.saveVersion({ ...SCOPE, config: validConfig(), actor: 'consultant_2' })
  await store.approve({ ...SCOPE, id: saved.id, actor: 'approver_1' })
  await store.retire({ ...SCOPE, id: saved.id, actor: 'approver_1' })

  const audit = await store.listAudit({ ...SCOPE, configId: saved.id })
  assert.equal(audit.length, 4)
  assert.deepEqual(
    audit.map((entry) => entry.action).sort(),
    ['reuse_version', 'save_version', 'status_change', 'status_change'],
  )
  const text = JSON.stringify(db.tables[AUDIT_TABLE])
  for (const leak of Object.values(DISTINCTIVE)) {
    assert.ok(!text.includes(leak), `audit trail must not contain config content: ${leak}`)
  }
  const statusChange = audit.find((entry) => entry.detail && entry.detail.to === 'approved')
  // sanitizeIntegrationPayload returns a null-prototype clone — spread before comparing.
  assert.deepEqual({ ...statusChange.detail }, { from: 'draft', to: 'approved' })
}

async function testContentKeyHelperIsStable() {
  const key1 = __internals.contentKeyFor({ b: 2, a: [1, { d: 4, c: 3 }] })
  const key2 = __internals.contentKeyFor({ a: [1, { c: 3, d: 4 }], b: 2 })
  assert.equal(key1, key2, 'content key is key-order independent')
  assert.notEqual(key1, __internals.contentKeyFor({ a: [1, { c: 3, d: 4 }], b: 3 }))
}

async function main() {
  await testInvalidConfigRejectedValuesFree()
  await testSaveStoresNormalizedOnlyAndMintsDraft()
  await testContentKeyIdempotency()
  await testFamilyIsolation()
  await testStatusTransitionsFailClosed()
  await testScopingAndNotFound()
  await testAuditTrailIsValuesFree()
  await testContentKeyHelperIsStable()
  console.log('read-source-config-store.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
