'use strict'

// Read-source resolver composition C-R1 — content-keyed store + values-free audit.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  ReadSourceCompositionConfigValidationError,
  ReadSourceCompositionConfigConflictError,
  ReadSourceCompositionConfigNotApprovedError,
  createReadSourceCompositionConfigStore,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'read-source-composition-config-store.cjs'))
const { validateReadSourceCompositionConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-composition-config.cjs'))

const CONFIG_TABLE = 'integration_read_source_composition_configs'
const AUDIT_TABLE = 'integration_read_source_composition_config_audit'

function createMockDb() {
  const tables = { [CONFIG_TABLE]: [], [AUDIT_TABLE]: [] }
  function matchesWhere(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }
  return {
    tables,
    calls: [],
    async selectOne(table, where) {
      this.calls.push(['selectOne', table, { ...where }])
      return tables[table].find((row) => matchesWhere(row, where)) || null
    },
    async insertOne(table, row) {
      this.calls.push(['insertOne', table, JSON.parse(JSON.stringify(row))])
      const stored = {
        ...row,
        created_at: row.created_at || '2026-07-04T00:00:00.000Z',
        updated_at: row.updated_at || '2026-07-04T00:00:00.000Z',
      }
      tables[table].push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      this.calls.push(['updateRow', table, { ...set }, { ...where }])
      const row = tables[table].find((candidate) => matchesWhere(candidate, where))
      if (!row) return []
      Object.assign(row, set, { updated_at: '2026-07-04T01:00:00.000Z' })
      return [row]
    },
    async select(table, options = {}) {
      this.calls.push(['select', table, JSON.parse(JSON.stringify(options))])
      const filtered = tables[table].filter((row) => matchesWhere(row, options.where || {}))
      return filtered.slice(options.offset || 0, (options.offset || 0) + (options.limit || 1000))
    },
    async transaction(callback) {
      this.calls.push(['transaction'])
      return callback(this)
    },
  }
}

function readConfig({ id, target, status = 'approved', mode = 'resolver_lookup' }) {
  return {
    id,
    status,
    config: {
      version: 1,
      systemId: 'sys_1',
      requiredKind: 'erp:k3-wise-webapi',
      object: 'material',
      mode,
      readPath: '/K3API/Material/GetDetail',
      readMethod: 'POST',
      operations: ['read'],
      keyField: 'FNumber',
      containerPaths: ['Data'],
      resolverRule: 'exactly_one',
      fieldMap: [{ source: 'Data.FItemID', target }],
    },
  }
}

function createReadConfigStore(overrides = {}) {
  const refs = new Map([
    ['read_cfg_material_item', readConfig({ id: 'read_cfg_material_item', target: 'resolved_item_id', ...(overrides.first || {}) })],
    ['read_cfg_bom_number', readConfig({ id: 'read_cfg_bom_number', target: 'resolved_bom_number', ...(overrides.second || {}) })],
  ])
  const calls = []
  return {
    refs,
    calls,
    async getForRuntime({ id }) {
      calls.push(id)
      const row = refs.get(id)
      if (!row || row.status !== 'approved') throw new Error('not approved')
      return row
    },
  }
}

function validComposition(overrides = {}) {
  return {
    version: 1,
    name: 'material_to_bom',
    operations: ['read'],
    steps: [
      { id: 'resolve_item', readSourceConfigId: 'read_cfg_material_item' },
      {
        id: 'resolve_bom',
        readSourceConfigId: 'read_cfg_bom_number',
        input: { fromStep: 'resolve_item', sourceTarget: 'resolved_item_id', toInput: 'key' },
      },
    ],
    ...overrides,
  }
}

function newStore(overrides = {}) {
  const db = createMockDb()
  const readSourceConfigStore = createReadConfigStore(overrides)
  let seq = 0
  const store = createReadSourceCompositionConfigStore({
    db,
    readSourceConfigStore,
    idGenerator: () => `composition_id_${++seq}`,
  })
  return { db, readSourceConfigStore, store }
}

const SCOPE = { tenantId: 'tenant_1', workspaceId: 'workspace_1' }

async function testSaveStoresNormalizedAndApprovedRefsOnly() {
  const { db, readSourceConfigStore, store } = newStore()
  const saved = await store.saveVersion({
    ...SCOPE,
    actor: 'consultant_1',
    config: validComposition({ name: ' material_to_bom ' }),
  })
  assert.equal(saved.reused, false)
  assert.equal(saved.status, 'draft')
  assert.equal(saved.version, 1)
  assert.deepEqual(readSourceConfigStore.calls, ['read_cfg_material_item', 'read_cfg_bom_number'])
  const row = db.tables[CONFIG_TABLE][0]
  const expected = JSON.parse(JSON.stringify(validateReadSourceCompositionConfig(validComposition(), { readConfigsById: readSourceConfigStore.refs }).normalized))
  expected.version = row.version
  assert.deepEqual(JSON.parse(JSON.stringify(row.config)), expected, 'stored config is exactly the normalized composition structure with minted version')
  assert.equal(row.name, 'material_to_bom')
}

async function testRejectedRefDoesNotPersistOrAudit() {
  const { db, store } = newStore({ first: { status: 'draft' } })
  await assert.rejects(
    () => store.saveVersion({ ...SCOPE, actor: 'consultant_1', config: validComposition() }),
    (error) => {
      assert.ok(error instanceof ReadSourceCompositionConfigValidationError)
      assert.equal(error.details.errors[0].code, 'READ_SOURCE_COMPOSITION_STEP_NOT_APPROVED')
      assert.ok(!JSON.stringify(error.details).includes('read_cfg_material_item'), 'approval error must not echo the rejected config id')
      return true
    },
  )
  assert.equal(db.tables[CONFIG_TABLE].length, 0)
  assert.equal(db.tables[AUDIT_TABLE].length, 0)
}

async function testContentKeyIdempotencyAndVersionMinting() {
  const { db, store } = newStore()
  const first = await store.saveVersion({ ...SCOPE, actor: 'a', config: validComposition() })
  const reversed = { ...validComposition(), steps: validComposition().steps.map((step) => Object.fromEntries(Object.entries(step).reverse())) }
  const second = await store.saveVersion({ ...SCOPE, actor: 'b', config: reversed })
  assert.equal(second.reused, true)
  assert.equal(second.id, first.id)
  assert.equal(db.tables[CONFIG_TABLE].length, 1)
  assert.deepEqual(db.tables[AUDIT_TABLE].map((row) => row.action), ['save_version', 'reuse_version'])

  const third = await store.saveVersion({ ...SCOPE, actor: 'c', config: validComposition({ name: 'material_to_bom', steps: [
    { id: 'resolve_item', readSourceConfigId: 'read_cfg_material_item' },
    { id: 'resolve_bom_alt', readSourceConfigId: 'read_cfg_bom_number', input: { fromStep: 'resolve_item', sourceTarget: 'resolved_item_id', toInput: 'key' } },
  ] }) })
  assert.equal(third.reused, false)
  assert.equal(third.version, 2)
  assert.equal(db.tables[CONFIG_TABLE].length, 2)
}

async function testRetiredContentFailsClosed() {
  const { db, store } = newStore()
  const saved = await store.saveVersion({ ...SCOPE, actor: 'a', config: validComposition() })
  await store.approve({ ...SCOPE, id: saved.id, actor: 'a' })
  await store.retire({ ...SCOPE, id: saved.id, actor: 'a' })
  const auditBefore = db.tables[AUDIT_TABLE].length
  await assert.rejects(
    () => store.saveVersion({ ...SCOPE, actor: 'a', config: validComposition() }),
    (error) => {
      assert.ok(error instanceof ReadSourceCompositionConfigConflictError)
      assert.equal(error.details.reason, 'content_retired')
      return true
    },
  )
  assert.equal(db.tables[AUDIT_TABLE].length, auditBefore)
}

async function testLifecycleAndRuntimeApprovedOnly() {
  const { db, store } = newStore()
  const saved = await store.saveVersion({ ...SCOPE, actor: 'a', config: validComposition() })
  await assert.rejects(
    () => store.getForRuntime({ ...SCOPE, id: saved.id }),
    (error) => error instanceof ReadSourceCompositionConfigNotApprovedError,
  )
  await store.approve({ ...SCOPE, id: saved.id, actor: 'a' })
  const runtime = await store.getForRuntime({ ...SCOPE, id: saved.id })
  assert.equal(runtime.status, 'approved')
  await store.retire({ ...SCOPE, id: saved.id, actor: 'a' })
  await assert.rejects(
    () => store.getForRuntime({ ...SCOPE, id: saved.id }),
    (error) => error instanceof ReadSourceCompositionConfigNotApprovedError,
  )
  assert.deepEqual(db.tables[AUDIT_TABLE].map((row) => row.action), ['save_version', 'status_change', 'status_change'])
}

async function testAuditIsValuesFree() {
  const { db, store } = newStore()
  const saved = await store.saveVersion({
    ...SCOPE,
    actor: 'consultant_1',
    config: validComposition({ name: 'material_to_bom_SECRET_NAME' }),
  })
  await store.approve({ ...SCOPE, id: saved.id, actor: 'consultant_1' })
  const text = JSON.stringify(db.tables[AUDIT_TABLE])
  for (const leak of ['read_cfg_material_item', 'read_cfg_bom_number', 'resolved_item_id', 'SECRET_NAME', 'FItemID']) {
    assert.ok(!text.includes(leak), `audit must not leak config detail ${leak}: ${text}`)
  }
  for (const row of db.tables[AUDIT_TABLE]) {
    assert.deepEqual(Object.keys(row.detail).sort(), row.action === 'status_change' ? ['from', 'to'] : ['version'])
  }
}

function testStableContentKey() {
  assert.equal(
    __internals.contentKeyFor({ version: 1, b: 2, a: [{ d: 4, c: 3 }] }),
    __internals.contentKeyFor({ version: 99, a: [{ c: 3, d: 4 }], b: 2 }),
  )
  assert.notEqual(
    __internals.contentKeyFor({ version: 1, a: 1 }),
    __internals.contentKeyFor({ version: 1, a: 2 }),
  )
}

async function testUniqueViolationRouting() {
  const CONTENT_CONSTRAINT = 'uniq_integration_read_source_composition_configs_content'
  const VERSION_CONSTRAINT = 'uniq_integration_read_source_composition_configs_family_version'

  function raceDb({ constraint, failures = 1, winnerRowAfterFailure = null }) {
    const base = createMockDb()
    let remainingFailures = failures
    let insertsBlocked = failures
    const wrapped = {
      ...base,
      tables: base.tables,
      calls: base.calls,
      async selectOne(table, where) {
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

  const refs = createReadConfigStore().refs
  const normalized = validateReadSourceCompositionConfig(validComposition(), { readConfigsById: refs }).normalized
  const winnerConfig = JSON.parse(JSON.stringify(normalized))
  winnerConfig.version = 1
  const winnerRow = {
    id: 'composition_winner',
    tenant_id: 'tenant_1',
    workspace_id: 'workspace_1',
    name: 'material_to_bom',
    config: winnerConfig,
    content_key: __internals.contentKeyFor(normalized),
    version: 1,
    status: 'draft',
    created_at: 'x',
    updated_at: 'x',
  }

  const contentDb = raceDb({ constraint: CONTENT_CONSTRAINT, failures: 1, winnerRowAfterFailure: winnerRow })
  const contentStore = createReadSourceCompositionConfigStore({
    db: contentDb,
    readSourceConfigStore: createReadConfigStore(),
    idGenerator: () => 'composition_id_x',
  })
  const reused = await contentStore.saveVersion({ ...SCOPE, config: validComposition(), actor: 'c' })
  assert.equal(reused.reused, true)
  assert.equal(reused.id, 'composition_winner')
  assert.equal(contentDb.tables[CONFIG_TABLE].length, 1, 'loser never inserts a duplicate composition row')
  assert.deepEqual(contentDb.tables[AUDIT_TABLE].map((row) => row.action), ['reuse_version'])

  const transientDb = raceDb({ constraint: VERSION_CONSTRAINT, failures: 1 })
  const transientStore = createReadSourceCompositionConfigStore({
    db: transientDb,
    readSourceConfigStore: createReadConfigStore(),
    idGenerator: () => 'composition_id_y',
  })
  const minted = await transientStore.saveVersion({ ...SCOPE, config: validComposition(), actor: 'c' })
  assert.equal(minted.reused, false)
  assert.equal(minted.version, 1)
  assert.equal(transientDb.tables[CONFIG_TABLE].length, 1)

  const persistentDb = raceDb({ constraint: VERSION_CONSTRAINT, failures: 99 })
  const persistentStore = createReadSourceCompositionConfigStore({
    db: persistentDb,
    readSourceConfigStore: createReadConfigStore(),
    idGenerator: () => 'composition_id_z',
  })
  await assert.rejects(
    () => persistentStore.saveVersion({ ...SCOPE, config: validComposition(), actor: 'c' }),
    (error) => {
      assert.ok(error instanceof ReadSourceCompositionConfigConflictError)
      assert.equal(error.details.reason, 'mint_conflict')
      return true
    },
  )
  const attempts = persistentDb.calls.filter(([name]) => name === 'transaction').length
  assert.equal(attempts, 3, 'mint retries are bounded at 3 attempts')

  const foreignDb = raceDb({ constraint: 'some_other_constraint', failures: 1 })
  const foreignStore = createReadSourceCompositionConfigStore({
    db: foreignDb,
    readSourceConfigStore: createReadConfigStore(),
    idGenerator: () => 'composition_id_w',
  })
  await assert.rejects(
    () => foreignStore.saveVersion({ ...SCOPE, config: validComposition(), actor: 'c' }),
    (error) => error.code === '23505' && error.constraint === 'some_other_constraint',
  )
}

async function main() {
  await testSaveStoresNormalizedAndApprovedRefsOnly()
  await testRejectedRefDoesNotPersistOrAudit()
  await testContentKeyIdempotencyAndVersionMinting()
  await testRetiredContentFailsClosed()
  await testLifecycleAndRuntimeApprovedOnly()
  await testAuditIsValuesFree()
  testStableContentKey()
  await testUniqueViolationRouting()
  console.log('read-source-composition-config-store.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
