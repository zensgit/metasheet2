'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  WriteTargetConfigValidationError,
  WriteTargetConfigConflictError,
  WriteTargetConfigNotFoundError,
  createWriteTargetConfigStore,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'write-target-config-store.cjs'))
const { validateWriteTargetConfig } = require(path.join(__dirname, '..', 'lib', 'write-target-config.cjs'))

const CONFIG_TABLE = 'integration_write_target_configs'
const AUDIT_TABLE = 'integration_write_target_config_audit'

function createMockDb() {
  const tables = { [CONFIG_TABLE]: [], [AUDIT_TABLE]: [] }
  const calls = []
  function matchesWhere(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }
  const db = {
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
        created_at: row.created_at || '2026-07-04T00:00:00.000Z',
        updated_at: row.updated_at || '2026-07-04T00:00:00.000Z',
      }
      tables[table].push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      calls.push(['updateRow', table, { ...set }, { ...where }])
      const row = tables[table].find((candidate) => matchesWhere(candidate, where))
      if (!row) return []
      Object.assign(row, set, { updated_at: '2026-07-04T01:00:00.000Z' })
      return [row]
    },
    async select(table, options = {}) {
      calls.push(['select', table, JSON.parse(JSON.stringify(options))])
      return tables[table]
        .filter((row) => matchesWhere(row, options.where || {}))
        .slice(options.offset || 0, (options.offset || 0) + (options.limit || 1000))
    },
    async transaction(callback) {
      calls.push(['transaction'])
      return callback(db)
    },
  }
  return db
}

const DISTINCTIVE = Object.freeze({
  writePath: '/K3API/Distinctive/Save',
  keyField: 'FDistinctiveNumber',
  source: 'cleansing_distinctive_name',
  target: 'Data.FDistinctiveName',
})

function validConfig(overrides = {}) {
  return {
    version: 1,
    systemId: 'prod_sys',
    sandboxSystemId: 'sandbox_sys',
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material',
    operation: 'upsert',
    writePath: DISTINCTIVE.writePath,
    writeMethod: 'POST',
    operations: ['write'],
    keyField: DISTINCTIVE.keyField,
    keyEncoding: 'structured_json_field',
    fieldMap: [{ source: DISTINCTIVE.source, target: DISTINCTIVE.target }],
    ...overrides,
  }
}

function newStore() {
  const db = createMockDb()
  let seq = 0
  const store = createWriteTargetConfigStore({ db, idGenerator: () => `id_${++seq}` })
  return { db, store }
}

const SCOPE = Object.freeze({ tenantId: 'tenant_1', workspaceId: 'workspace_1' })

async function testInvalidConfigRejectedValuesFree() {
  const { db, store } = newStore()
  await assert.rejects(
    () => store.saveVersion({ ...SCOPE, config: validConfig({ writePath: 'https://evil.example.com/x' }), actor: 'consultant_1' }),
    (error) => {
      assert.ok(error instanceof WriteTargetConfigValidationError)
      const text = JSON.stringify({ message: error.message, details: error.details })
      assert.ok(!text.includes('evil.example.com'), 'validation error must not echo endpoint values')
      return true
    },
  )
  await assert.rejects(
    () => store.saveVersion({ ...SCOPE, config: validConfig({ bearerToken: 'sk-super-secret' }), actor: 'consultant_1' }),
    (error) => {
      assert.ok(error instanceof WriteTargetConfigValidationError)
      assert.ok(!JSON.stringify(error.details).includes('sk-super-secret'))
      return true
    },
  )
  assert.equal(db.tables[CONFIG_TABLE].length, 0)
  assert.equal(db.tables[AUDIT_TABLE].length, 0)
}

async function testSaveStoresNormalizedOnlyAndMintsDraft() {
  const { db, store } = newStore()
  const saved = await store.saveVersion({
    ...SCOPE,
    config: validConfig({ systemId: ' prod_sys ', sandboxSystemId: ' sandbox_sys ', object: ' material ', writePath: 'K3API/Distinctive/Save' }),
    actor: 'consultant_1',
  })
  assert.equal(saved.reused, false)
  assert.equal(saved.version, 1)
  assert.equal(saved.status, 'draft')
  assert.equal(saved.systemId, 'prod_sys')
  assert.equal(saved.sandboxSystemId, 'sandbox_sys')
  assert.equal(saved.config.writePath, '/K3API/Distinctive/Save')
  const row = db.tables[CONFIG_TABLE][0]
  const expected = JSON.parse(JSON.stringify(validateWriteTargetConfig(validConfig()).normalized))
  expected.version = row.version
  assert.deepEqual(JSON.parse(JSON.stringify(row.config)), expected)
  assert.equal(row.config.version, row.version)
  assert.equal(row.created_by, 'consultant_1')
}

async function testContentKeyIdempotencyAndMinting() {
  const { db, store } = newStore()
  const first = await store.saveVersion({ ...SCOPE, config: validConfig(), actor: 'consultant_1' })
  const reordered = Object.fromEntries(Object.entries(validConfig({ systemId: ' prod_sys ' })).reverse())
  const second = await store.saveVersion({ ...SCOPE, config: reordered, actor: 'consultant_2' })
  assert.equal(second.reused, true)
  assert.equal(second.id, first.id)
  assert.equal(second.version, 1)
  assert.equal(db.tables[CONFIG_TABLE].length, 1)
  assert.deepEqual(db.tables[AUDIT_TABLE].map((row) => row.action), ['save_version', 'reuse_version'])

  const versionOnly = await store.saveVersion({ ...SCOPE, config: validConfig({ version: 42 }), actor: 'consultant_1' })
  assert.equal(versionOnly.reused, true)
  assert.equal(db.tables[CONFIG_TABLE].length, 1)

  const changed = await store.saveVersion({ ...SCOPE, config: validConfig({ writeMethod: 'PATCH' }), actor: 'consultant_1' })
  assert.equal(changed.reused, false)
  assert.equal(changed.version, 2)
  assert.equal(db.tables[CONFIG_TABLE].length, 2)
  assert.equal(db.tables[CONFIG_TABLE].find((row) => row.version === 2).config.version, 2)
}

async function testStatusLifecycleAndAuditValuesFree() {
  const { db, store } = newStore()
  const saved = await store.saveVersion({ ...SCOPE, config: validConfig(), actor: 'consultant_1' })
  await assert.rejects(
    () => store.retire({ ...SCOPE, id: saved.id, actor: 'consultant_1' }),
    (error) => error instanceof WriteTargetConfigConflictError,
  )
  const approved = await store.approve({ ...SCOPE, id: saved.id, actor: 'consultant_1' })
  assert.equal(approved.status, 'approved')
  await assert.rejects(
    () => store.approve({ ...SCOPE, id: saved.id, actor: 'consultant_1' }),
    (error) => error instanceof WriteTargetConfigConflictError,
  )
  const retired = await store.retire({ ...SCOPE, id: saved.id, actor: 'consultant_1' })
  assert.equal(retired.status, 'retired')

  const audit = await store.listAudit({ ...SCOPE, configId: saved.id })
  const auditText = JSON.stringify(audit)
  for (const leak of [DISTINCTIVE.writePath, DISTINCTIVE.keyField, DISTINCTIVE.source, DISTINCTIVE.target, 'prod_sys', 'sandbox_sys']) {
    assert.ok(!auditText.includes(leak), `audit must not include ${leak}`)
  }
  assert.deepEqual(audit.map((row) => row.action).sort(), ['save_version', 'status_change', 'status_change'])
  const auditSelect = db.calls.filter(([name, table]) => name === 'select' && table === AUDIT_TABLE).at(-1)
  assert.deepEqual(auditSelect[2].orderBy, ['created_at', 'DESC'])
}

async function testRetiredContentReuseFailsClosed() {
  const { db, store } = newStore()
  const saved = await store.saveVersion({ ...SCOPE, config: validConfig(), actor: 'consultant_1' })
  await store.approve({ ...SCOPE, id: saved.id, actor: 'consultant_1' })
  await store.retire({ ...SCOPE, id: saved.id, actor: 'consultant_1' })
  const auditCountBefore = db.tables[AUDIT_TABLE].length
  await assert.rejects(
    () => store.saveVersion({ ...SCOPE, config: validConfig(), actor: 'consultant_1' }),
    (error) => {
      assert.ok(error instanceof WriteTargetConfigConflictError)
      assert.equal(error.details.reason, 'content_retired')
      return true
    },
  )
  assert.equal(db.tables[AUDIT_TABLE].length, auditCountBefore)
  assert.equal(db.tables[CONFIG_TABLE].length, 1)
}

async function testUniqueViolationRouting() {
  const CONTENT_CONSTRAINT = 'uniq_integration_write_target_configs_content'
  const VERSION_CONSTRAINT = 'uniq_integration_write_target_configs_family_version'

  function raceDb({ constraint, failures = 1, winnerRowAfterFailure = null }) {
    const base = createMockDb()
    let remainingFailures = failures
    let insertsBlocked = failures
    const wrapped = {
      ...base,
      tables: base.tables,
      calls: base.calls,
      async selectOne(table, where) {
        // Simulate the race window: the winner row becomes visible only after our insert loses.
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

  const winnerRow = {
    id: 'wtc_winner',
    tenant_id: 'tenant_1',
    workspace_id: 'workspace_1',
    system_id: 'prod_sys',
    sandbox_system_id: 'sandbox_sys',
    object: 'material',
    operation: 'upsert',
    config: { systemId: 'prod_sys', sandboxSystemId: 'sandbox_sys', version: 1 },
    content_key: __internals.contentKeyFor(validateWriteTargetConfig(validConfig()).normalized),
    version: 1,
    status: 'draft',
    created_at: 'x',
    updated_at: 'x',
  }
  const contentDb = raceDb({ constraint: CONTENT_CONSTRAINT, failures: 1, winnerRowAfterFailure: winnerRow })
  const contentStore = createWriteTargetConfigStore({ db: contentDb, idGenerator: () => 'id_x' })
  const reused = await contentStore.saveVersion({ ...SCOPE, config: validConfig(), actor: 'consultant_1' })
  assert.equal(reused.reused, true)
  assert.equal(reused.id, 'wtc_winner')
  assert.equal(contentDb.tables[CONFIG_TABLE].length, 1)
  assert.deepEqual(contentDb.tables[AUDIT_TABLE].map((row) => row.action), ['reuse_version'])

  const transientDb = raceDb({ constraint: VERSION_CONSTRAINT, failures: 1 })
  const transientStore = createWriteTargetConfigStore({ db: transientDb, idGenerator: () => 'id_y' })
  const minted = await transientStore.saveVersion({ ...SCOPE, config: validConfig(), actor: 'consultant_1' })
  assert.equal(minted.reused, false)
  assert.equal(minted.version, 1)
  assert.equal(transientDb.tables[CONFIG_TABLE].length, 1)

  const persistentDb = raceDb({ constraint: VERSION_CONSTRAINT, failures: 99 })
  const persistentStore = createWriteTargetConfigStore({ db: persistentDb, idGenerator: () => 'id_z' })
  await assert.rejects(
    () => persistentStore.saveVersion({ ...SCOPE, config: validConfig(), actor: 'consultant_1' }),
    (error) => {
      assert.ok(error instanceof WriteTargetConfigConflictError)
      assert.equal(error.details.reason, 'mint_conflict')
      return true
    },
  )
  const attempts = persistentDb.calls.filter(([name]) => name === 'transaction').length
  assert.equal(attempts, 3, 'mint retries are bounded at 3 attempts')

  const foreignDb = raceDb({ constraint: 'some_other_constraint', failures: 1 })
  const foreignStore = createWriteTargetConfigStore({ db: foreignDb, idGenerator: () => 'id_w' })
  await assert.rejects(
    () => foreignStore.saveVersion({ ...SCOPE, config: validConfig(), actor: 'consultant_1' }),
    (error) => error.code === '23505' && error.constraint === 'some_other_constraint',
  )
}

async function testListGetAndNotFound() {
  const { store } = newStore()
  const saved = await store.saveVersion({ ...SCOPE, config: validConfig(), actor: 'consultant_1' })
  assert.equal((await store.list(SCOPE)).length, 1)
  assert.equal((await store.list({ ...SCOPE, status: 'draft' })).length, 1)
  assert.equal((await store.get({ ...SCOPE, id: saved.id })).id, saved.id)
  await assert.rejects(
    () => store.get({ tenantId: 'tenant_2', workspaceId: 'workspace_1', id: saved.id }),
    (error) => error instanceof WriteTargetConfigNotFoundError,
  )
  assert.equal((await store.list({ tenantId: 'tenant_2', workspaceId: 'workspace_1' })).length, 0, 'list is tenant-scoped')
  await assert.rejects(
    () => store.list({ ...SCOPE, status: 'everything' }),
    (error) => error instanceof WriteTargetConfigValidationError,
  )
  await assert.rejects(
    () => store.get({ ...SCOPE, id: 'missing' }),
    (error) => error instanceof WriteTargetConfigNotFoundError,
  )
}

async function main() {
  await testInvalidConfigRejectedValuesFree()
  await testSaveStoresNormalizedOnlyAndMintsDraft()
  await testContentKeyIdempotencyAndMinting()
  await testStatusLifecycleAndAuditValuesFree()
  await testRetiredContentReuseFailsClosed()
  await testUniqueViolationRouting()
  await testListGetAndNotFound()
  console.log('write-target-config-store.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
