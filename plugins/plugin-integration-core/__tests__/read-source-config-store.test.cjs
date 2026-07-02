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
const { validateReadSourceConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-config.cjs'))

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
    async transaction(callback) {
      calls.push(['transaction'])
      return callback(this)
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
  // ENTIRE stored structure === S1 normalized output, with version overwritten to the MINTED
  // row version (the caller-typed version field never survives into storage).
  const expected = JSON.parse(JSON.stringify(validateReadSourceConfig(validConfig()).normalized))
  expected.version = row.version
  assert.deepEqual(JSON.parse(JSON.stringify(row.config)), expected, 'stored config is exactly the normalized structure with the minted version')
  assert.equal(row.config.version, row.version, 'stored config.version mirrors the minted row version')
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

  // Same effective config differing ONLY in the caller-typed version field → still reused
  // (version is excluded from the content key).
  const versionOnly = await store.saveVersion({ ...SCOPE, config: validConfig({ version: 42 }), actor: 'consultant_1' })
  assert.equal(versionOnly.reused, true)
  assert.equal(versionOnly.id, first.id)
  assert.equal(db.tables[CONFIG_TABLE].length, 1)

  // Changed content → next version in the family; its stored config carries the MINTED version.
  const third = await store.saveVersion({ ...SCOPE, config: validConfig({ readMethod: 'GET' }), actor: 'consultant_1' })
  assert.equal(third.reused, false)
  assert.equal(third.version, 2)
  assert.equal(db.tables[CONFIG_TABLE].length, 2)
  const mintedRow = db.tables[CONFIG_TABLE].find((row) => row.version === 2)
  assert.equal(mintedRow.config.version, 2, 'stored config.version === minted row version')
}

// Review item 3: identical content whose only existing row is RETIRED must NOT be silently
// revived as reused — it conflicts, and appends no audit row.
async function testRetiredContentReuseFailsClosed() {
  const { db, store } = newStore()
  const saved = await store.saveVersion({ ...SCOPE, config: validConfig(), actor: 'c' })
  await store.approve({ ...SCOPE, id: saved.id, actor: 'c' })
  await store.retire({ ...SCOPE, id: saved.id, actor: 'c' })
  const auditCountBefore = db.tables[AUDIT_TABLE].length
  await assert.rejects(
    () => store.saveVersion({ ...SCOPE, config: validConfig(), actor: 'c' }),
    (error) => {
      assert.ok(error instanceof ReadSourceConfigConflictError)
      assert.equal(error.details.reason, 'content_retired')
      return true
    },
  )
  assert.equal(db.tables[AUDIT_TABLE].length, auditCountBefore, 'retired-content conflict appends no audit row')
  assert.equal(db.tables[CONFIG_TABLE].length, 1, 'no new row minted')
}

// Review item 1c: 23505 routing. Content-key violation → the concurrent winner's row is reused;
// family-version violation → bounded retry, then typed Conflict when persistent.
async function testUniqueViolationRouting() {
  const CONTENT_CONSTRAINT = 'uniq_integration_read_source_configs_content'
  const VERSION_CONSTRAINT = 'uniq_integration_read_source_configs_family_version'

  function raceDb({ constraint, failures = 1, winnerRowAfterFailure = null }) {
    const base = createMockDb()
    let remainingFailures = failures
    let insertsBlocked = failures
    const wrapped = {
      ...base,
      tables: base.tables,
      calls: base.calls,
      async selectOne(table, where) {
        // Simulate the race window: the winner's row becomes visible only AFTER our insert failed.
        if (winnerRowAfterFailure && table === CONFIG_TABLE && insertsBlocked > 0) return null
        if (winnerRowAfterFailure && table === CONFIG_TABLE && insertsBlocked === 0 && base.tables[CONFIG_TABLE].length === 0) {
          base.tables[CONFIG_TABLE].push(winnerRowAfterFailure)
        }
        return base.selectOne(table, where)
      },
      async insertOne(table, row) {
        if (table === CONFIG_TABLE && remainingFailures > 0) {
          remainingFailures -= 1
          insertsBlocked -= 1
          const error = new Error('duplicate key value violates unique constraint')
          error.code = '23505'
          error.constraint = constraint
          throw error
        }
        return base.insertOne(table, row)
      },
      async transaction(callback) {
        base.calls.push(['transaction'])
        return callback(wrapped)
      },
    }
    return wrapped
  }

  // (a) content-key violation → reuse the winner's row (no new config row, reuse audit appended).
  const winnerRow = {
    id: 'rsc_winner',
    tenant_id: 'tenant_1',
    workspace_id: 'workspace_1',
    system_id: 'sys_1',
    object: 'material',
    mode: 'single_record',
    config: { systemId: 'sys_1', version: 1 },
    content_key: __internals.contentKeyFor(validateReadSourceConfig(validConfig()).normalized),
    version: 1,
    status: 'draft',
    created_at: 'x',
    updated_at: 'x',
  }
  const contentDb = raceDb({ constraint: CONTENT_CONSTRAINT, failures: 1, winnerRowAfterFailure: winnerRow })
  const contentStore = createReadSourceConfigStore({ db: contentDb, idGenerator: () => 'id_x' })
  const reused = await contentStore.saveVersion({ ...SCOPE, config: validConfig(), actor: 'c' })
  assert.equal(reused.reused, true)
  assert.equal(reused.id, 'rsc_winner')
  assert.equal(contentDb.tables[CONFIG_TABLE].length, 1, 'loser never inserts a duplicate content row')
  assert.deepEqual(contentDb.tables[AUDIT_TABLE].map((row) => row.action), ['reuse_version'])

  // (b) transient version violation → retry mints successfully.
  const transientDb = raceDb({ constraint: VERSION_CONSTRAINT, failures: 1 })
  const transientStore = createReadSourceConfigStore({ db: transientDb, idGenerator: () => 'id_y' })
  const minted = await transientStore.saveVersion({ ...SCOPE, config: validConfig(), actor: 'c' })
  assert.equal(minted.reused, false)
  assert.equal(minted.version, 1)
  assert.equal(transientDb.tables[CONFIG_TABLE].length, 1)

  // (c) persistent version violation → bounded retry (3) then typed Conflict.
  const persistentDb = raceDb({ constraint: VERSION_CONSTRAINT, failures: 99 })
  const persistentStore = createReadSourceConfigStore({ db: persistentDb, idGenerator: () => 'id_z' })
  await assert.rejects(
    () => persistentStore.saveVersion({ ...SCOPE, config: validConfig(), actor: 'c' }),
    (error) => {
      assert.ok(error instanceof ReadSourceConfigConflictError)
      assert.equal(error.details.reason, 'mint_conflict')
      return true
    },
  )
  const insertAttempts = persistentDb.calls.filter(([name]) => name === 'transaction').length
  assert.equal(insertAttempts, 3, 'mint retries are bounded at 3 attempts')

  // (d) an unrelated 23505 (unknown constraint) is NOT swallowed.
  const foreignDb = raceDb({ constraint: 'some_other_constraint', failures: 1 })
  const foreignStore = createReadSourceConfigStore({ db: foreignDb, idGenerator: () => 'id_w' })
  await assert.rejects(
    () => foreignStore.saveVersion({ ...SCOPE, config: validConfig(), actor: 'c' }),
    (error) => error.code === '23505' && error.constraint === 'some_other_constraint',
  )
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
  // version is EXCLUDED from the hash input: the row version is store-minted.
  assert.equal(
    __internals.contentKeyFor({ a: 1, version: 1 }),
    __internals.contentKeyFor({ a: 1, version: 99 }),
    'caller-typed version field does not participate in the content key',
  )
}

async function main() {
  await testInvalidConfigRejectedValuesFree()
  await testSaveStoresNormalizedOnlyAndMintsDraft()
  await testContentKeyIdempotency()
  await testFamilyIsolation()
  await testStatusTransitionsFailClosed()
  await testRetiredContentReuseFailsClosed()
  await testUniqueViolationRouting()
  await testScopingAndNotFound()
  await testAuditTrailIsValuesFree()
  await testContentKeyHelperIsStable()
  console.log('read-source-config-store.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
