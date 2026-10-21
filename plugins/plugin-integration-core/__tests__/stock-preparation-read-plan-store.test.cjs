'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  validateStockPreparationReadPlanConfig,
} = require('../lib/stock-preparation-read-plan-config.cjs')
const {
  VERSION_TABLE, ACTIVATION_TABLE, AUDIT_TABLE, VALIDATION_TABLE, createStockPreparationReadPlanStore,
} = require('../lib/stock-preparation-read-plan-store.cjs')
const { SOURCE_REVISION_TABLE } = require('../lib/stock-preparation-read-plan-validation-ledger.cjs')

function config(systemId = 'source-one') {
  const role = (object, fields) => ({ object, ...Object.fromEntries(fields.map((field) => [field, field])) })
  return {
    schemaVersion: 1,
    actionId: 'plm.stock-preparation.pull-bom.v1',
    systemId,
    readPlan: {
      id: 'plm.stock-preparation.bom-read.user-draft.v1',
      sourceKind: 'data-source:sql-readonly', matchField: 'matchField', maxReadCount: 200,
      pathExAttr: role('SYN_PathLink', ['matchField', 'pathIdField']),
      pathInfo: role('SYN_Path', ['idField']),
      orderHead: role('SYN_Order', ['idField', 'pathIdField']),
      orderDetail: role('SYN_OrderLine', ['orderIdField', 'componentIdField', 'quantityField']),
      part: role('SYN_Part', ['idField']),
      bomHead: role('SYN_Bom', ['parentPartField', 'bomIdField']),
      bomDetail: role('SYN_BomLine', ['bomParentField', 'componentIdField', 'quantityField']),
    },
  }
}
const scope = { tenantId: 'tenant-one', workspaceId: 'workspace-one' }
const tenantScope = { tenantId: 'tenant-one', workspaceId: null }
const SOURCE_CONNECTION = 'source-one-connection'
const BINDING_REVISION = '11111111-1111-4111-8111-111111111111'
const CONNECTION_REVISION = '22222222-2222-4222-8222-222222222222'
const AUTOMATION_REVISION = 'abcdef12-3456-4789-abcd-0123456789ab'
const STATUS_FIXTURE_COUNTS = Object.freeze({ sampleCount: 2, readCount: 10, objectCount: 7 })
const STATUS_FIXTURE_SOURCE = Object.freeze({
  connectionId: SOURCE_CONNECTION,
  connectionRevision: CONNECTION_REVISION,
  bindingRevision: BINDING_REVISION,
})
function clone(value) { return structuredClone(value) }
function system(overrides = {}) {
  return {
    id: 'source-one', tenant_id: 'tenant-one', workspace_id: 'workspace-one',
    kind: 'data-source:sql-readonly', role: 'source', status: 'active',
    connection_id: SOURCE_CONNECTION, validation_revision: BINDING_REVISION, ...overrides,
  }
}
function sourceRevision(binding) {
  return {
    data_source_id: binding.connection_id, validation_revision: CONNECTION_REVISION,
    tenant_id: binding.tenant_id, workspace_id: null, owner_id: 'actor-one', scope_kind: 'private',
    type: 'postgresql', is_active: true, deleted_at: null,
  }
}
function memoryDb({ systems = [system()] } = {}) {
  const bound = clone(systems)
  let state = {
    [VERSION_TABLE]: [], [ACTIVATION_TABLE]: [], [AUDIT_TABLE]: [], [VALIDATION_TABLE]: [],
    [SOURCE_REVISION_TABLE]: bound.filter((row) => typeof row.connection_id === 'string').map(sourceRevision),
    integration_external_systems: bound,
  }
  const trace = []
  let failAudit = false
  let uniqueFailures = 0
  let activationUniqueFailures = 0
  function match(row, where) { return Object.entries(where).every(([key, value]) => row[key] === value) }
  function helper(data) {
    return {
      async select(table, { where = {}, orderBy, limit = 1000, offset = 0 } = {}) {
        trace.push(`select:${table}`)
        const found = data[table].filter((row) => match(row, where))
        if (orderBy) {
          const [key, direction] = orderBy
          found.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (direction === 'DESC' ? -1 : 1))
        }
        return clone(found.slice(offset, offset + limit))
      },
      async selectOne(table, where) { trace.push(`selectOne:${table}`); return clone(data[table].find((row) => match(row, where)) || null) },
      async selectOneForUpdate(table, where) { trace.push(`forUpdate:${table}`); return clone(data[table].find((row) => match(row, where)) || null) },
      async selectOneForKeyShare(table, where) { trace.push(`keyShare:${table}`); return clone(data[table].find((row) => match(row, where)) || null) },
      async insertOne(table, row) {
        trace.push(`insert:${table}`)
        if (table === AUDIT_TABLE && failAudit) throw new Error('synthetic audit failure')
        if (table === VERSION_TABLE && uniqueFailures-- > 0) {
          const error = new Error('synthetic unique violation')
          error.code = '23505'; error.constraint = 'uniq_integration_stock_prep_read_plan_family_version'
          throw error
        }
        if (table === ACTIVATION_TABLE && activationUniqueFailures-- > 0) {
          const error = new Error('synthetic activation scope race')
          error.code = '23505'; error.constraint = 'uniq_integration_stock_prep_read_plan_activation_scope'
          throw error
        }
        const saved = { ...clone(row), created_at: 'synthetic-time', updated_at: 'synthetic-time' }
        data[table].push(saved)
        return [clone(saved)]
      },
      async updateRow(table, set, where) {
        trace.push(`update:${table}`)
        const row = data[table].find((item) => match(item, where))
        if (!row) return []
        Object.assign(row, clone(set))
        return [clone(row)]
      },
      async setTransactionIsolationLevel(level) { trace.push(`isolation:${level}`) },
    }
  }
  return {
    ...Object.fromEntries(['select', 'selectOne', 'selectOneForUpdate', 'selectOneForKeyShare', 'insertOne', 'updateRow']
      .map((name) => [name, (...args) => helper(state)[name](...args)])),
    trace,
    get state() { return state },
    set failAudit(value) { failAudit = value },
    set uniqueFailures(value) { uniqueFailures = value },
    set activationUniqueFailures(value) { activationUniqueFailures = value },
    async transaction(callback) {
      trace.push('transaction')
      const working = clone(state)
      const result = await callback(helper(working))
      state = working
      return result
    },
  }
}
let nextId = 0
function store(db) { return createStockPreparationReadPlanStore({ db, idGenerator: () => `synthetic-id-${++nextId}` }) }
function eligibleDb() { return memoryDb({ systems: [system({ workspace_id: null })] }) }
// Synthetic status fixture, NOT source-validation proof. The PostgreSQL host suite
// owns the measured gate. This only plants a confirmed receipt for the current revision.
async function seedConfirmedStatusFixture(ledger, id, actor = 'actor-one') {
  const source = { connectionId: SOURCE_CONNECTION, connectionRevision: CONNECTION_REVISION }
  const input = { ...tenantScope, actor, id, source }
  const begun = await ledger.beginValidation(input)
  await ledger.finishValidation({ ...input, validationId: begun.validationId, counts: STATUS_FIXTURE_COUNTS })
  await ledger.confirmValidation({ ...input, validationId: begun.validationId })
  return begun
}

test('strict validator accepts synthetic roles and order BOM version, rejects extensions and unsafe values without echo', () => {
  const valid = config()
  valid.readPlan.orderDetail.versionField = 'bom_revision'
  valid.readPlan.bomHead.versionField = 'bom_revision'
  assert.deepEqual(validateStockPreparationReadPlanConfig(valid).readPlan.orderDetail.versionField, 'bom_revision')
  const cases = [
    (value) => { value.credential = 'secret' },
    (value) => { value.readPlan.projectSubtree = {} },
    (value) => { value.readPlan.part.tenantId = 'tenant' },
    (value) => { value.readPlan.part.object = 'https://evil.invalid' },
    (value) => { value.readPlan.maxReadCount = 1001 },
    (value) => { value.readPlan.bomHead.versionField = undefined },
    (value) => { value.readPlan.matchField = 'other' },
    (value) => { value.systemId = 'https://evil.invalid' },
    (value) => { value.readPlan.part.codeField = null },
    (value) => { value.readPlan.part.codeField = '' },
    (value) => { value.readPlan.part.codeField = '   ' },
    (value) => { value.readPlan.orderDetail.versionField = null },
    (value) => { value.readPlan.orderDetail.versionField = '' },
    (value) => { value.readPlan.orderDetail.versionField = '   ' },
  ]
  for (const mutate of cases) {
    const input = clone(valid)
    mutate(input)
    assert.throws(() => validateStockPreparationReadPlanConfig(input), (error) => {
      assert.match(error.code, /^READ_PLAN_[A-Z_]+$/)
      assert.equal(error.message, error.code)
      assert.doesNotMatch(error.message, /secret|https|tenant-one|evil/)
      return true
    })
  }
})

test('strict object grammar accepts one or two ascii segments and does not echo rejected names', () => {
  const acceptedName = (objectName) => {
    const input = clone(config())
    input.readPlan.part.object = objectName
    return validateStockPreparationReadPlanConfig(input).readPlan.part.object
  }
  assert.equal(acceptedName(' order_line '), 'order_line')
  assert.equal(acceptedName(' order_1 '), 'order_1')
  assert.equal(acceptedName(' sales_schema.order_line '), 'sales_schema.order_line')
  assert.equal(acceptedName('sales_schema.order_1'), 'sales_schema.order_1')
  assert.equal(acceptedName('_schema_name._table_name'), '_schema_name._table_name')
  assert.equal(acceptedName(`ab.${'c'.repeat(125)}`), `ab.${'c'.repeat(125)}`)
  const fieldOk = clone(config())
  fieldOk.readPlan.part.codeField = ' code_1 '
  assert.equal(validateStockPreparationReadPlanConfig(fieldOk).readPlan.part.codeField, 'code_1')

  const rejected = [
    'sales..order_line',
    '  sales..order_line  ',
    'order_line.',
    '.order_line',
    'db.sales.order_line',
    'sales_schema.1order_line',
    '1order_line',
    'order_line;sentinel_drop_marker',
    'order_line\' OR sentinel_quote_marker',
    'sales.select',
    'from_orders',
    'b'.repeat(129),
    `ab.${'c'.repeat(126)}`,
  ]
  const accepted = []
  for (const objectName of rejected) {
    const input = clone(config())
    input.readPlan.part.object = objectName
    try {
      validateStockPreparationReadPlanConfig(input)
      accepted.push(objectName)
    } catch (error) {
      assert.equal(error.code, 'READ_PLAN_IDENTIFIER_INVALID')
      assert.equal(error.message, error.code)
      assert.equal(error.message.includes(objectName), false)
    }
  }
  assert.deepEqual(accepted, [])

  const dottedField = clone(config())
  dottedField.readPlan.part.codeField = 'schema.column'
  assert.throws(() => validateStockPreparationReadPlanConfig(dottedField), (error) => {
    assert.equal(error.code, 'READ_PLAN_IDENTIFIER_INVALID')
    assert.equal(error.message, error.code)
    assert.equal(error.message.includes('schema.column'), false)
    return true
  })
})

test('save/reuse, approve/runtime, retire and scoped audit are one family with immutable content', async () => {
  const db = eligibleDb()
  const ledger = store(db)
  const input = { ...tenantScope, actor: 'actor-one', config: config() }
  const saved = await ledger.saveVersion(input)
  assert.equal(saved.version, 1)
  assert.equal(saved.status, 'draft')
  assert.deepEqual(db.trace.slice(0, 4), ['transaction', 'isolation:read committed',
    'forUpdate:integration_external_systems', `forUpdate:${SOURCE_REVISION_TABLE}`])
  const reused = await ledger.saveVersion(input)
  assert.equal(reused.id, saved.id)
  assert.equal(db.state[VERSION_TABLE].length, 1)
  await assert.rejects(ledger.getForRuntime({ ...tenantScope, id: saved.id, actionId: input.config.actionId, systemId: input.config.systemId }), /READ_PLAN_NOT_APPROVED/)
  await assert.rejects(ledger.retire({ ...tenantScope, id: saved.id, actor: 'actor-one' }), /READ_PLAN_STATUS_CONFLICT/)
  const proof = await seedConfirmedStatusFixture(ledger, saved.id)
  const approved = await ledger.approve({ ...tenantScope, id: saved.id, actor: 'actor-one' })
  assert.equal(approved.status, 'approved')
  assert.equal(approved.validationId, proof.validationId)
  assert.equal((await ledger.getForRuntime({ ...tenantScope, id: saved.id, actionId: input.config.actionId, systemId: input.config.systemId })).id, saved.id)
  assert.equal((await ledger.list({ scope: tenantScope })).length, 1)
  assert.equal((await ledger.listAudit({ ...tenantScope, id: saved.id })).length, 6)
  assert.equal(await ledger.get({ ...tenantScope, workspaceId: 'another', id: saved.id }), null)
  await assert.rejects(ledger.listAudit({ ...tenantScope, workspaceId: 'another', id: saved.id }), /READ_PLAN_NOT_FOUND/)
  await assert.rejects(ledger.getForRuntime({ ...tenantScope, id: saved.id, actionId: input.config.actionId, systemId: 'other' }), /READ_PLAN_NOT_FOUND/)
  await assert.rejects(ledger.getForRuntime({ ...tenantScope, workspaceId: 'another', id: saved.id, actionId: input.config.actionId, systemId: input.config.systemId }), /READ_PLAN_NOT_FOUND/)
  await assert.rejects(ledger.getForRuntime({ ...tenantScope, id: saved.id, actionId: 'other-action', systemId: input.config.systemId }), /READ_PLAN_NOT_FOUND/)
  await assert.rejects(ledger.getForRuntime({ ...tenantScope, tenantId: 'other', id: saved.id, actionId: input.config.actionId, systemId: input.config.systemId }), /READ_PLAN_NOT_FOUND/)
  await ledger.retire({ ...tenantScope, id: saved.id, actor: 'actor-one' })
  await assert.rejects(ledger.saveVersion(input), /READ_PLAN_CONTENT_RETIRED/)
  assert.equal(db.state[VERSION_TABLE].length, 1)
})

test('mint increments beyond 10000 without family scan; bounded unique retry starts fresh transaction', async () => {
  const db = memoryDb()
  const ledger = store(db)
  const first = await ledger.saveVersion({ ...scope, actor: 'actor-one', config: config() })
  db.state[VERSION_TABLE][0].version = 10001
  const secondConfig = config(); secondConfig.readPlan.part.codeField = 'codeField'
  db.uniqueFailures = 1
  const second = await ledger.saveVersion({ ...scope, actor: 'actor-one', config: secondConfig })
  assert.equal(second.version, 10002)
  assert.equal(db.trace.filter((entry) => entry === 'transaction').length, 3)
  assert.ok(db.trace.filter((entry) => entry === 'isolation:read committed').length === 3)
  assert.ok(db.trace.includes(`select:${VERSION_TABLE}`))
  assert.equal(first.version, 1)
  db.uniqueFailures = 3
  const thirdConfig = config(); thirdConfig.readPlan.part.nameField = 'nameField'
  await assert.rejects(ledger.saveVersion({ ...scope, actor: 'actor-one', config: thirdConfig }), /READ_PLAN_MINT_CONFLICT/)
  assert.equal(db.state[VERSION_TABLE].length, 2)
})

test('audit failure rolls back mint/approval; tampered approved content is refused', async () => {
  const db = eligibleDb()
  const ledger = store(db)
  db.failAudit = true
  await assert.rejects(ledger.saveVersion({ ...tenantScope, actor: 'actor-one', config: config() }), /synthetic audit failure/)
  assert.equal(db.state[VERSION_TABLE].length, 0)
  db.failAudit = false
  const saved = await ledger.saveVersion({ ...tenantScope, actor: 'actor-one', config: config() })
  await seedConfirmedStatusFixture(ledger, saved.id)
  db.failAudit = true
  await assert.rejects(ledger.approve({ ...tenantScope, id: saved.id, actor: 'actor-one' }), /synthetic audit failure/)
  assert.equal(db.state[VERSION_TABLE][0].status, 'draft')
  db.failAudit = false
  await ledger.approve({ ...tenantScope, id: saved.id, actor: 'actor-one' })
  db.state[VERSION_TABLE][0].config.readPlan.part.object = 'Changed'
  await assert.rejects(ledger.getForRuntime({ ...tenantScope, id: saved.id, actionId: config().actionId, systemId: 'source-one' }), /READ_PLAN_CONTENT_INVALID/)
  // A changed stored shape that normalizes back to the same hash is still tampering.
  db.state[VERSION_TABLE][0].config.readPlan.part.object = ' SYN_Part '
  await assert.rejects(ledger.getForRuntime({ ...tenantScope, id: saved.id, actionId: config().actionId, systemId: 'source-one' }), /READ_PLAN_CONTENT_INVALID/)
})

test('scope, actor, source eligibility, and locking seams fail closed', async () => {
  const db = memoryDb()
  const ledger = store(db)
  const args = { ...scope, actor: 'actor-one', config: config() }
  await assert.rejects(ledger.saveVersion({ ...args, workspaceId: undefined }), /READ_PLAN_SCOPE_INVALID/)
  await assert.rejects(ledger.saveVersion({ ...args, actor: '' }), /READ_PLAN_ACTOR_INVALID/)
  await assert.rejects(ledger.saveVersion({ ...args, tenantId: 'other' }), /READ_PLAN_SOURCE_INELIGIBLE/)
  await assert.rejects(ledger.saveVersion({ ...args, workspaceId: 'other' }), /READ_PLAN_SOURCE_INELIGIBLE/)
  const tenantWide = memoryDb({ systems: [system({ workspace_id: null })] })
  assert.equal((await store(tenantWide).saveVersion(args)).version, 1)
  const bidirectional = memoryDb({ systems: [system({ role: 'bidirectional' })] })
  assert.equal((await store(bidirectional).saveVersion(args)).version, 1)
  const nullWorkspace = memoryDb({ systems: [system({ workspace_id: null })] })
  assert.equal((await store(nullWorkspace).saveVersion({ ...args, workspaceId: null })).workspaceId, null)
  for (const changed of [{ kind: 'erp:k3-wise-webapi' }, { status: 'inactive' }, { role: 'target' }, { role: 'unknown' }]) {
    const other = memoryDb({ systems: [system(changed)] })
    await assert.rejects(store(other).saveVersion(args), /READ_PLAN_SOURCE_INELIGIBLE/)
  }
  assert.throws(() => createStockPreparationReadPlanStore({ db: { selectOne() {} } }), /scoped transactional db required/)
  const noLock = memoryDb()
  noLock.transaction = async (callback) => callback({ ...noLock, selectOneForKeyShare: undefined })
  await assert.rejects(store(noLock).saveVersion(args), /READ_PLAN_TRANSACTION_UNAVAILABLE/)
  const noIsolation = memoryDb()
  noIsolation.transaction = async (callback) => callback({ ...noIsolation, setTransactionIsolationLevel: undefined })
  await assert.rejects(store(noIsolation).saveVersion(args), /READ_PLAN_TRANSACTION_UNAVAILABLE/)
  const noTransaction = memoryDb()
  noTransaction.transaction = undefined
  assert.throws(() => store(noTransaction), /scoped transactional db required/)
})

test('activation is exact-scope, approved-only, generation fenced, and disabled never falls back', async () => {
  const db = eligibleDb()
  const ledger = store(db)
  const actionId = config().actionId
  const runtime = { ...tenantScope, actionId, systemId: 'source-one' }
  assert.equal(await ledger.getActivation({ ...tenantScope, actionId }), null)
  assert.equal(await ledger.getActiveForRuntime(runtime), null)
  await assert.rejects(ledger.deactivate({ ...tenantScope, actionId, actor: 'actor-one', expectedGeneration: 0 }), /READ_PLAN_ACTIVATION_NOT_FOUND/)
  const version = await ledger.saveVersion({ ...tenantScope, actor: 'actor-one', config: config() })
  await assert.rejects(ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 0 }), /READ_PLAN_NOT_APPROVED/)
  const proof = await seedConfirmedStatusFixture(ledger, version.id)
  await ledger.approve({ ...tenantScope, id: version.id, actor: 'actor-one' })
  await assert.rejects(ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 1 }), /READ_PLAN_GENERATION_CONFLICT/)
  await assert.rejects(ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one' }), /READ_PLAN_GENERATION_INVALID/)
  const beforeTrace = db.trace.length
  const first = await ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 0 })
  assert.equal(first.generation, 1)
  assert.equal(first.status, 'active')
  assert.equal(first.validationId, proof.validationId)
  assert.deepEqual(db.trace.slice(beforeTrace, beforeTrace + 8), [
    `selectOne:${VERSION_TABLE}`, `selectOne:${ACTIVATION_TABLE}`, 'transaction', 'isolation:read committed',
    'forUpdate:integration_external_systems', `forUpdate:${SOURCE_REVISION_TABLE}`,
    `forUpdate:${VERSION_TABLE}`, `forUpdate:${VALIDATION_TABLE}`,
  ])
  assert.ok(db.trace.indexOf(`forUpdate:${VALIDATION_TABLE}`, beforeTrace) < db.trace.indexOf(`forUpdate:${ACTIVATION_TABLE}`, beforeTrace))
  assert.ok(db.trace.indexOf(`forUpdate:${VERSION_TABLE}`, beforeTrace) < db.trace.indexOf(`forUpdate:${ACTIVATION_TABLE}`, beforeTrace))
  const active = await ledger.getActiveForRuntime({ ...runtime, expectedGeneration: 1 })
  assert.equal(active.version.id, version.id)
  assert.equal(active.activation.validationId, proof.validationId)
  assert.deepEqual(active.sourceValidation, STATUS_FIXTURE_SOURCE)
  await assert.rejects(ledger.getActiveForRuntime({ ...runtime, expectedGeneration: 0 }), /READ_PLAN_GENERATION_CONFLICT/)
  await assert.rejects(ledger.getActiveForRuntime({ ...runtime, systemId: 'other' }), /READ_PLAN_ACTIVATION_SOURCE_MISMATCH/)
  assert.equal(await ledger.getActivation({ ...tenantScope, workspaceId: 'other', actionId }), null)
  assert.equal(await ledger.getActiveForRuntime({ ...runtime, tenantId: 'other' }), null)
  assert.equal(await ledger.getActiveForRuntime({ ...runtime, workspaceId: 'other' }), null)
  await assert.rejects(ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 0 }), /READ_PLAN_GENERATION_CONFLICT/)
  const again = await ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 1 })
  assert.equal(again.generation, 2) // even identical reactivation is a new epoch
  const beforeDisableTrace = db.trace.length
  const disabled = await ledger.deactivate({ ...tenantScope, actionId, actor: 'actor-one', expectedGeneration: 2 })
  assert.equal(disabled.status, 'disabled')
  assert.equal(disabled.generation, 3)
  assert.equal(disabled.versionId, version.id)
  assert.deepEqual(db.trace.slice(beforeDisableTrace, beforeDisableTrace + 6), [
    `selectOne:${ACTIVATION_TABLE}`, 'transaction', 'isolation:read committed',
    'forUpdate:integration_external_systems', `forUpdate:${SOURCE_REVISION_TABLE}`, `forUpdate:${VERSION_TABLE}`,
  ])
  assert.ok(db.trace.indexOf(`forUpdate:${VERSION_TABLE}`, beforeDisableTrace) < db.trace.indexOf(`forUpdate:${ACTIVATION_TABLE}`, beforeDisableTrace))
  assert.equal((await ledger.getActivation({ ...tenantScope, actionId })).generation, 3)
  await assert.rejects(ledger.getActiveForRuntime(runtime), /READ_PLAN_ACTIVATION_DISABLED/)
  await assert.rejects(ledger.deactivate({ ...tenantScope, actionId, actor: 'actor-one', expectedGeneration: 2 }), /READ_PLAN_GENERATION_CONFLICT/)
  const disabledAgain = await ledger.deactivate({ ...tenantScope, actionId, actor: 'actor-one', expectedGeneration: 3 })
  assert.equal(disabledAgain.generation, 4)
  const reactivated = await ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 4 })
  assert.equal(reactivated.generation, 5)
  assert.equal((await ledger.getActiveForRuntime({ ...runtime, expectedGeneration: 5 })).version.id, version.id)
  const audit = await ledger.listAudit({ ...tenantScope, id: version.id })
  assert.deepEqual(audit.filter((entry) => entry.action === 'activate').map((entry) => entry.detail.generation).sort((a, b) => a - b), [1, 2, 5])
  assert.deepEqual(audit.filter((entry) => entry.action === 'deactivate').map((entry) => entry.detail.generation).sort((a, b) => a - b), [3, 4])
  assert.deepEqual(Object.keys(audit.find((entry) => entry.action === 'activate').detail).sort(), ['generation', 'previousGeneration'])
})

test('activation switches approved versions, refuses mismatched scope/source and retired runtime', async () => {
  const db = eligibleDb()
  const ledger = store(db)
  const first = await ledger.saveVersion({ ...tenantScope, actor: 'actor-one', config: config() })
  const changed = config(); changed.readPlan.part.codeField = 'codeField'
  const second = await ledger.saveVersion({ ...tenantScope, actor: 'actor-one', config: changed })
  const firstProof = await seedConfirmedStatusFixture(ledger, first.id)
  await ledger.approve({ ...tenantScope, id: first.id, actor: 'actor-one' })
  const secondProof = await seedConfirmedStatusFixture(ledger, second.id)
  await ledger.approve({ ...tenantScope, id: second.id, actor: 'actor-one' })
  await assert.rejects(ledger.activate({ ...tenantScope, workspaceId: 'other', id: first.id, actor: 'actor-one', expectedGeneration: 0 }), /READ_PLAN_NOT_FOUND/)
  await assert.rejects(ledger.activate({ ...tenantScope, tenantId: 'other', id: first.id, actor: 'actor-one', expectedGeneration: 0 }), /READ_PLAN_NOT_FOUND/)
  const active = await ledger.activate({ ...tenantScope, id: first.id, actor: 'actor-one', expectedGeneration: 0 })
  assert.equal(active.validationId, firstProof.validationId)
  const switched = await ledger.activate({ ...tenantScope, id: second.id, actor: 'actor-one', expectedGeneration: active.generation })
  assert.equal(switched.versionId, second.id)
  assert.equal(switched.generation, 2)
  assert.equal(switched.validationId, secondProof.validationId)
  const loaded = await ledger.getActiveForRuntime({ ...tenantScope, actionId: changed.actionId, systemId: 'source-one' })
  assert.equal(loaded.version.id, second.id)
  assert.deepEqual(loaded.sourceValidation, STATUS_FIXTURE_SOURCE)
  await ledger.retire({ ...tenantScope, id: second.id, actor: 'actor-one' })
  await assert.rejects(ledger.getActiveForRuntime({ ...tenantScope, actionId: changed.actionId, systemId: 'source-one' }), /READ_PLAN_NOT_APPROVED/)
  await assert.rejects(ledger.activate({ ...tenantScope, id: second.id, actor: 'actor-one', expectedGeneration: 2 }), /READ_PLAN_NOT_APPROVED/)
  const disabled = await ledger.deactivate({ ...tenantScope, actionId: changed.actionId, actor: 'actor-one', expectedGeneration: 2 })
  assert.equal(disabled.status, 'disabled')
  assert.equal(disabled.versionId, second.id)
})

test('activation source eligibility, first-insert race, and audit rollback refuse without pointer changes', async () => {
  const db = eligibleDb()
  const ledger = store(db)
  const version = await ledger.saveVersion({ ...tenantScope, actor: 'actor-one', config: config() })
  await seedConfirmedStatusFixture(ledger, version.id)
  await ledger.approve({ ...tenantScope, id: version.id, actor: 'actor-one' })
  db.state.integration_external_systems[0].kind = 'erp:k3-wise-webapi'
  await assert.rejects(ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 0 }), /READ_PLAN_VALIDATION_SOURCE_INELIGIBLE/)
  db.state.integration_external_systems[0].kind = 'data-source:sql-readonly'
  db.state.integration_external_systems[0].workspace_id = 'other'
  await assert.rejects(ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 0 }), /READ_PLAN_VALIDATION_SOURCE_INELIGIBLE/)
  db.state.integration_external_systems[0].workspace_id = null
  db.activationUniqueFailures = 1
  await assert.rejects(ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 0 }), /READ_PLAN_GENERATION_CONFLICT/)
  assert.equal(db.state[ACTIVATION_TABLE].length, 0)
  db.failAudit = true
  await assert.rejects(ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 0 }), /synthetic audit failure/)
  assert.equal(db.state[ACTIVATION_TABLE].length, 0)
  db.failAudit = false
  const pointer = await ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 0 })
  db.failAudit = true
  await assert.rejects(ledger.deactivate({ ...tenantScope, actionId: config().actionId, actor: 'actor-one', expectedGeneration: 1 }), /synthetic audit failure/)
  assert.equal(db.state[ACTIVATION_TABLE][0].status, 'active')
  assert.equal(db.state[ACTIVATION_TABLE][0].generation, pointer.generation)
  assert.equal((await ledger.listAudit({ ...tenantScope, id: version.id })).filter((entry) => entry.action === 'deactivate').length, 0)
})

test('runtime refuses a pointer that changes between version and pointer reads', async () => {
  const db = eligibleDb()
  const ledger = store(db)
  const version = await ledger.saveVersion({ ...tenantScope, actor: 'actor-one', config: config() })
  await seedConfirmedStatusFixture(ledger, version.id)
  await ledger.approve({ ...tenantScope, id: version.id, actor: 'actor-one' })
  await ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 0 })
  const original = db.selectOne
  let drift = false
  db.selectOne = async (table, where) => {
    const row = await original(table, where)
    if (drift && table === VERSION_TABLE) db.state[ACTIVATION_TABLE][0].generation += 1
    return row
  }
  drift = true
  await assert.rejects(ledger.getActiveForRuntime({ ...tenantScope, actionId: config().actionId, systemId: 'source-one' }), /READ_PLAN_GENERATION_CONFLICT/)
})

test('generation overflow and pointer-content mismatch fail closed', async () => {
  const db = eligibleDb()
  const ledger = store(db)
  const version = await ledger.saveVersion({ ...tenantScope, actor: 'actor-one', config: config() })
  await seedConfirmedStatusFixture(ledger, version.id)
  await ledger.approve({ ...tenantScope, id: version.id, actor: 'actor-one' })
  await ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 0 })
  const runtime = { ...tenantScope, actionId: config().actionId, systemId: 'source-one' }
  db.state[ACTIVATION_TABLE][0].content_key = '0'.repeat(64)
  await assert.rejects(ledger.getActiveForRuntime(runtime), /READ_PLAN_ACTIVATION_INVALID/)
  const corruptState = JSON.stringify(db.state)
  await assert.rejects(ledger.deactivate({ ...tenantScope, actionId: config().actionId, actor: 'actor-one', expectedGeneration: 1 }), /READ_PLAN_ACTIVATION_INVALID/)
  assert.equal(JSON.stringify(db.state), corruptState)
  db.state[ACTIVATION_TABLE][0].content_key = version.contentKey
  db.state[ACTIVATION_TABLE][0].generation = 2147483647
  await assert.rejects(ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 2147483647 }), /READ_PLAN_GENERATION_EXHAUSTED/)
  await assert.rejects(ledger.deactivate({ ...tenantScope, actionId: config().actionId, actor: 'actor-one', expectedGeneration: 2147483647 }), /READ_PLAN_GENERATION_EXHAUSTED/)
  assert.equal(db.state[ACTIVATION_TABLE][0].generation, 2147483647)
})

test('explicit activation replaces corrupt old pointer content only from a rechecked approved target', async () => {
  const db = eligibleDb()
  const ledger = store(db)
  const version = await ledger.saveVersion({ ...tenantScope, actor: 'actor-one', config: config() })
  await seedConfirmedStatusFixture(ledger, version.id)
  await ledger.approve({ ...tenantScope, id: version.id, actor: 'actor-one' })
  await ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 0 })
  db.state[ACTIVATION_TABLE][0].content_key = '0'.repeat(64)
  const replacement = await ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 1 })
  assert.equal(replacement.contentKey, version.contentKey)
  assert.equal(replacement.generation, 2)
  const loaded = await ledger.getActiveForRuntime({ ...tenantScope, actionId: config().actionId, systemId: 'source-one' })
  assert.equal(loaded.version.id, version.id)
  assert.deepEqual(loaded.sourceValidation, STATUS_FIXTURE_SOURCE)
})

// SQL-shaped fixture, not a PostgreSQL lock simulator. This drives the real
// structured DB helper and shared source/receipt validators; a separate host
// PostgreSQL suite must prove that row locks survive until the caller commits.
function automationQueryable(db, { arrayResult = false, xids = ['101', '101'],
  isolation = ['read committed', 'read committed'], beforeSelect } = {}) {
  const statements = []
  let probes = 0
  const result = rows => arrayResult ? clone(rows) : { rows: clone(rows), rowCount: rows.length }
  return {
    statements,
    async query(sql, params = []) {
      statements.push({ sql, params: clone(params) })
      if (sql === "SELECT pg_current_xact_id()::text AS xid, current_setting('transaction_isolation') AS isolation_level") {
        const index = probes++
        return result([{ xid: xids[index], isolation_level: isolation[index] }])
      }
      if (sql.includes('AS raw_authority')) {
        const table = /FROM "([a-z_]+)" r/.exec(sql)[1]
        assert.ok([VERSION_TABLE, VALIDATION_TABLE, ACTIVATION_TABLE].includes(table))
        const locked = sql.endsWith(' FOR UPDATE')
        assert.ok(locked || table === ACTIVATION_TABLE)
        const where = { tenant_id: params[0], workspace_id: params[1],
          [table === ACTIVATION_TABLE ? 'action_id' : 'id']: params[2] }
        if (table === VALIDATION_TABLE) where.version_id = params[3]
        if (beforeSelect) await beforeSelect({ table, locked, where })
        const found = db.state[table].find(row => Object.entries(where).every(([key, value]) => row[key] === value))
        if (!found) return result([])
        // Simulate only the SQL JSON/timestamp transport, never DB nonce or lock guarantees.
        const row = clone(found)
        const clocks = table === VALIDATION_TABLE ? ['begun_at', 'expires_at', 'finished_at', 'confirmed_at'] : ['created_at', 'updated_at']
        for (const key of clocks) {
          row[key] = row[key] === null ? null : new Date(row[key]).toISOString().replace(/([0-9]{3})Z$/, '$1000Z')
        }
        return result([{ raw_authority: row }])
      }
      const parsed = /^SELECT \* FROM "([a-z_]+)" WHERE (.+) LIMIT 1(?: OFFSET 0)?( FOR UPDATE)?$/.exec(sql)
      assert.ok(parsed, `Unexpected SQL in readonly source prerequisite: ${sql}`)
      const [, table, conditions, locked] = parsed
      assert.ok(Object.hasOwn(db.state, table), 'Only fixture-owned integration metadata can be queried')
      const where = Object.fromEntries(conditions.split(' AND ').map(condition => {
        const term = /^"([a-z_]+)" (?:IS NULL|= \$(\d+))$/.exec(condition)
        assert.ok(term, `Unexpected structured predicate: ${condition}`)
        return [term[1], term[2] ? params[Number(term[2]) - 1] : null]
      }))
      if (beforeSelect) await beforeSelect({ table, locked: Boolean(locked), where })
      return result(db.state[table].filter(row => Object.entries(where)
        .every(([key, value]) => row[key] === value)).slice(0, 1))
    },
  }
}
async function automationFixture() {
  const db = eligibleDb()
  const ledger = store(db)
  const version = await ledger.saveVersion({ ...tenantScope, actor: 'actor-one', config: config() })
  const proof = await seedConfirmedStatusFixture(ledger, version.id)
  await ledger.approve({ ...tenantScope, id: version.id, actor: 'actor-one' })
  const activation = await ledger.activate({ ...tenantScope, id: version.id, actor: 'actor-one', expectedGeneration: 0 })
  // These are status fixtures only. Real nonce minting/ABA is proven by the PG suite.
  for (const table of [VERSION_TABLE, VALIDATION_TABLE, ACTIVATION_TABLE]) {
    for (const row of db.state[table]) {
      row.automation_authority_revision = AUTOMATION_REVISION
      if (table !== VALIDATION_TABLE) {
        row.created_at = '2026-10-01T00:00:00.000Z'
        row.updated_at = '2026-10-01T00:00:00.000Z'
      }
    }
  }
  return { db, ledger, version, proof, activation,
    input: { ...tenantScope, actor: 'actor-one', actionId: config().actionId, systemId: 'source-one' } }
}

test('Automation source prerequisite uses caller transaction in the prescribed lock order, accepting Pg and host row shapes', async () => {
  for (const arrayResult of [false, true]) {
    const { db, ledger, input, version, proof, activation } = await automationFixture()
    const queryable = automationQueryable(db, { arrayResult })
    const beforeState = clone(db.state)
    const beforeTrace = clone(db.trace)
    const loaded = await ledger.lockActiveForAutomation(queryable, input)
    assert.equal(loaded.activation.id, activation.id)
    assert.equal(loaded.activation.validationId, proof.validationId)
    assert.equal(loaded.version.id, version.id)
    assert.deepEqual(loaded.sourceValidation, STATUS_FIXTURE_SOURCE)
    assert.equal(Object.isFrozen(loaded.sourceValidation), true)
    assert.deepEqual(Object.keys(loaded).sort(), ['activation', 'sourceAuthority', 'sourceValidation', 'version'])
    assert.deepEqual(Object.keys(loaded.sourceAuthority).sort(), ['activationRevision', 'receipt', 'receiptRevision', 'versionRevision'])
    assert.equal(loaded.sourceAuthority.versionRevision, AUTOMATION_REVISION)
    assert.equal(loaded.sourceAuthority.receiptRevision, AUTOMATION_REVISION)
    assert.equal(loaded.sourceAuthority.activationRevision, AUTOMATION_REVISION)
    assert.equal(loaded.sourceAuthority.receipt.id, proof.validationId)
    assert.equal(Object.isFrozen(loaded.sourceAuthority), true)
    assert.equal(Object.isFrozen(loaded.sourceAuthority.receipt), true)
    assert.equal(Object.isFrozen(loaded.sourceAuthority.receipt.counts), true)
    assert.deepEqual(queryable.statements.map(({ sql }) => {
      if (sql.includes('pg_current_xact_id()')) return 'transaction-probe'
      const table = /FROM "([a-z_]+)"/.exec(sql)[1]
      return `${sql.endsWith(' FOR UPDATE') ? 'lock' : 'hint'}:${table}`
    }), ['transaction-probe', 'transaction-probe', `hint:${ACTIVATION_TABLE}`,
      'lock:integration_external_systems', `lock:${SOURCE_REVISION_TABLE}`,
      `lock:${VERSION_TABLE}`, `lock:${VALIDATION_TABLE}`, `lock:${ACTIVATION_TABLE}`])
    assert.deepEqual(db.trace, beforeTrace, 'Must not use the store-owned database or transaction lifecycle')
    assert.deepEqual(db.state, beforeState, 'Must not write any metadata or source rows')
    assert.equal(queryable.statements.some(({ sql }) => /\b(BEGIN|COMMIT|ROLLBACK|SET|INSERT|UPDATE|DELETE)\b/.test(sql.replace(/ FOR UPDATE$/, ''))), false)
  }
})

test('Automation source prerequisite rejects unusable, autocommit, and non-read-committed handles with fixed errors', async () => {
  const { db, ledger, input } = await automationFixture()
  const cases = [undefined, {}, { query: false },
    { query: async () => { throw new Error('synthetic-sensitive-connection-details') } },
    { query: async () => null }, { query: async () => ({ rows: [] }) },
    automationQueryable(db, { xids: ['101', '102'] }),
    automationQueryable(db, { xids: ['101', ''] }),
    automationQueryable(db, { xids: [101, 101] }),
    automationQueryable(db, { isolation: ['repeatable read', 'repeatable read'] }),
    automationQueryable(db, { isolation: ['read committed', 'serializable'] }),
    Object.assign(automationQueryable(db, { xids: ['101', '102'] }), { isTransaction: true }),
  ]
  for (const queryable of cases) {
    await assert.rejects(ledger.lockActiveForAutomation(queryable, input), error => {
      assert.equal(error.code, 'READ_PLAN_TRANSACTION_UNAVAILABLE')
      assert.equal(error.status, 500)
      assert.equal(error.message, error.code)
      return true
    })
    if (queryable?.statements) assert.equal(queryable.statements.some(({ sql }) => sql.includes('FROM')), false)
  }
})

test('Automation source prerequisite requires exact tenant, explicit null workspace, actor and active source', async () => {
  const { db, ledger, input } = await automationFixture()
  const cases = [
    [{ ...input, tenantId: 'another' }, 'READ_PLAN_ACTIVATION_NOT_FOUND'],
    [{ ...input, tenantId: '' }, 'READ_PLAN_SCOPE_INVALID'],
    [{ ...input, workspaceId: undefined }, 'READ_PLAN_SCOPE_INVALID'],
    [{ tenantId: input.tenantId, actor: input.actor, actionId: input.actionId, systemId: input.systemId }, 'READ_PLAN_SCOPE_INVALID'],
    [{ ...input, workspaceId: 'workspace-one' }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [{ ...input, actor: undefined }, 'READ_PLAN_ACTOR_INVALID'],
    [{ ...input, actor: 'other-owner' }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [{ ...input, actionId: 'another-action' }, 'READ_PLAN_ACTIVATION_NOT_FOUND'],
    [{ ...input, systemId: 'another-source' }, 'READ_PLAN_ACTIVATION_SOURCE_MISMATCH'],
  ]
  for (const [args, code] of cases) {
    await assert.rejects(ledger.lockActiveForAutomation(automationQueryable(db), args), error => error.code === code)
  }
  db.state[ACTIVATION_TABLE][0].status = 'disabled'
  await assert.rejects(ledger.lockActiveForAutomation(automationQueryable(db), input), /READ_PLAN_ACTIVATION_DISABLED/)
  db.state[ACTIVATION_TABLE].length = 0
  await assert.rejects(ledger.lockActiveForAutomation(automationQueryable(db), input), /READ_PLAN_ACTIVATION_NOT_FOUND/)
})

test('Automation source prerequisite reuses binding and current private-owner source eligibility validators', async () => {
  const readable = await automationFixture()
  readable.db.state.integration_external_systems[0].role = 'bidirectional'
  assert.deepEqual((await readable.ledger.lockActiveForAutomation(automationQueryable(readable.db), readable.input)).sourceValidation,
    STATUS_FIXTURE_SOURCE)
  const mutations = [
    [state => { state.integration_external_systems[0].tenant_id = 'another' }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [state => { state.integration_external_systems[0].workspace_id = 'workspace-one' }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [state => { state.integration_external_systems[0].connection_id = null }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [state => { state.integration_external_systems[0].config = { dataSourceId: 'conflicting-legacy-source' } }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [state => { state.integration_external_systems[0].kind = 'erp:k3-wise-webapi' }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [state => { state.integration_external_systems[0].status = 'inactive' }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [state => { state.integration_external_systems[0].role = 'target' }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [state => { state[SOURCE_REVISION_TABLE][0].tenant_id = 'another' }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [state => { state[SOURCE_REVISION_TABLE][0].workspace_id = 'workspace-one' }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [state => { state[SOURCE_REVISION_TABLE][0].owner_id = 'another' }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [state => { state[SOURCE_REVISION_TABLE][0].scope_kind = 'workspace' }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [state => { state[SOURCE_REVISION_TABLE][0].is_active = false }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [state => { state[SOURCE_REVISION_TABLE][0].deleted_at = new Date() }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [state => { state[SOURCE_REVISION_TABLE][0].type = 'mysql' }, 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'],
    [state => { state.integration_external_systems[0].validation_revision = '33333333-3333-4333-8333-333333333333' }, 'READ_PLAN_VALIDATION_SOURCE_CHANGED'],
    [state => { state[SOURCE_REVISION_TABLE][0].validation_revision = '33333333-3333-4333-8333-333333333333' }, 'READ_PLAN_VALIDATION_SOURCE_CHANGED'],
  ]
  for (const [mutate, code] of mutations) {
    const { db, ledger, input } = await automationFixture()
    mutate(db.state)
    await assert.rejects(ledger.lockActiveForAutomation(automationQueryable(db), input), error => error.code === code)
  }
})

test('Automation source prerequisite refuses corrupt or retired versions and never borrows a receipt actor', async () => {
  const cases = [
    [state => { state[VERSION_TABLE][0].config.readPlan.part.object = 'Changed' }, 'READ_PLAN_CONTENT_INVALID'],
    [state => { state[VERSION_TABLE][0].config.readPlan.part.object = ' SYN_Part ' }, 'READ_PLAN_CONTENT_INVALID'],
    [state => { state[VERSION_TABLE][0].status = 'retired' }, 'READ_PLAN_NOT_APPROVED'],
    [state => { state[VERSION_TABLE][0].status = 'draft' }, 'READ_PLAN_NOT_APPROVED'],
    [state => { state[VERSION_TABLE].length = 0 }, 'READ_PLAN_ACTIVATION_INVALID'],
    [state => { state[VALIDATION_TABLE][0].actor = 'another' }, 'READ_PLAN_VALIDATION_ACTOR_MISMATCH'],
    [state => { state[VALIDATION_TABLE][0].status = 'passed'; state[VALIDATION_TABLE][0].confirmed_at = null }, 'READ_PLAN_VALIDATION_REQUIRED'],
    [state => { state[VALIDATION_TABLE][0].tenant_id = 'another' }, 'READ_PLAN_VALIDATION_INVALID'],
    [state => { state[ACTIVATION_TABLE][0].validation_id = null }, 'READ_PLAN_VALIDATION_REQUIRED'],
    [state => { state[ACTIVATION_TABLE][0].content_key = '0'.repeat(64) }, 'READ_PLAN_ACTIVATION_INVALID'],
  ]
  for (const [mutate, code] of cases) {
    const { db, ledger, input } = await automationFixture()
    mutate(db.state)
    await assert.rejects(ledger.lockActiveForAutomation(automationQueryable(db), input), error => error.code === code)
  }
})

test('Automation source prerequisite preserves the activation frozen receipt despite new pending evidence or receipt expiry', async () => {
  const { db, ledger, input, version, proof } = await automationFixture()
  const pending = await ledger.beginValidation({ ...tenantScope, actor: input.actor,
    id: version.id, source: STATUS_FIXTURE_SOURCE })
  assert.notEqual(pending.validationId, proof.validationId)
  const receipt = db.state[VALIDATION_TABLE].find(row => row.id === proof.validationId)
  for (const key of ['begun_at', 'expires_at', 'finished_at', 'confirmed_at']) {
    receipt[key] = new Date(new Date(receipt[key]).getTime() - 60 * 60 * 1000)
  }
  const loaded = await ledger.lockActiveForAutomation(automationQueryable(db), input)
  assert.equal(loaded.activation.validationId, proof.validationId)
  assert.equal(loaded.version.validationId, pending.validationId)
  assert.deepEqual(loaded.sourceValidation, STATUS_FIXTURE_SOURCE)
})

test('Automation source prerequisite rejects every pointer identity drift after the unlocked hint', async () => {
  const changes = [
    { id: 'replacement-pointer' }, { tenant_id: 'another' }, { workspace_id: 'workspace-one' },
    { action_id: 'another-action' }, { generation: 2 }, { status: 'disabled' },
    { version_id: 'replacement-version' }, { validation_id: 'replacement-receipt' },
    { system_id: 'replacement-source' }, { content_key: '0'.repeat(64) },
  ]
  for (const changed of changes) {
    const { db, ledger, input } = await automationFixture()
    const queryable = automationQueryable(db, { beforeSelect({ table, locked }) {
      if (table === ACTIVATION_TABLE && locked) Object.assign(db.state[ACTIVATION_TABLE][0], changed)
    } })
    await assert.rejects(ledger.lockActiveForAutomation(queryable, input), /READ_PLAN_GENERATION_CONFLICT/)
    assert.equal(queryable.statements.filter(({ sql }) => sql.endsWith(' FOR UPDATE')).length, 5)
  }
})

test('Automation source prerequisite requires DB epochs on all three actual source rows without public DTO leakage', async () => {
  for (const table of [VERSION_TABLE, VALIDATION_TABLE, ACTIVATION_TABLE]) {
    for (const revision of [undefined, null, '', 'invalid', AUTOMATION_REVISION.toUpperCase()]) {
      const { db, ledger, input } = await automationFixture()
      db.state[table][0].automation_authority_revision = revision
      await assert.rejects(ledger.lockActiveForAutomation(automationQueryable(db), input),
        error => error.code === 'READ_PLAN_AUTOMATION_AUTHORITY_INVALID')
    }
  }
  const { db, ledger, input } = await automationFixture()
  const loaded = await ledger.lockActiveForAutomation(automationQueryable(db), input)
  assert.equal(Object.hasOwn(loaded.version, 'automation_authority_revision'), false)
  assert.equal(Object.hasOwn(loaded.activation, 'automation_authority_revision'), false)
  db.state[VALIDATION_TABLE][0].counts.sampleCount = 999
  assert.deepEqual(loaded.sourceAuthority.receipt.counts, STATUS_FIXTURE_COUNTS)
})
