'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { test } = require('node:test')
const {
  composeStockPreparationReadPlanAction,
  normalizeStockPreparationActionConfig,
  assertStockPreparationTargetReady,
  assertLargeBomActionExecutionContract,
  largeBomBackgroundExpansionCaps,
  dryRunStockPreparationAction,
  applyStockPreparationAction,
  __internals: { buildRevision },
} = require('../lib/stock-preparation-table-actions.cjs')
const {
  createStockPreparationReadPlanStore, VERSION_TABLE, ACTIVATION_TABLE, AUDIT_TABLE, VALIDATION_TABLE,
} = require('../lib/stock-preparation-read-plan-store.cjs')
const { SOURCE_REVISION_TABLE } = require('../lib/stock-preparation-read-plan-validation-ledger.cjs')
const {
  createLargeBomBackgroundExpansionJob,
  runLargeBomBackgroundExpansionJob,
} = require('../lib/stock-preparation-large-bom-jobs.cjs')

const ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const SCOPE = Object.freeze({ tenantId: 'tenant-one', workspaceId: null })
const SOURCE_REVISION = '11111111-1111-4111-8111-111111111111'
const clone = (value) => structuredClone(value)

function baseAction(overrides = {}) {
  return {
    source: { externalSystemId: 'plm_source_1', kind: 'data-source:sql-readonly' },
    target: { sheetId: 'sheet_stock', objectId: 'stockPreparationMain' },
    rootSelection: { enabled: false },
    ...overrides,
  }
}

function config(maxReadCount = 100) {
  return {
    schemaVersion: 1, actionId: ACTION_ID, systemId: 'plm_source_1',
    readPlan: {
      id: 'plm.stock-preparation.bom-read.user-draft.v1',
      sourceKind: 'data-source:sql-readonly', matchField: 'project', maxReadCount,
      pathExAttr: { object: 'SYN_PathLink', matchField: 'project', pathIdField: 'path' },
      pathInfo: { object: 'SYN_Path', idField: 'id' },
      orderHead: { object: 'SYN_Order', idField: 'id', pathIdField: 'path' },
      orderDetail: { object: 'SYN_OrderLine', orderIdField: 'order', componentIdField: 'part', quantityField: 'qty' },
      part: { object: 'SYN_Part', idField: 'id', codeField: 'code', nameField: 'name' },
      bomHead: { object: 'SYN_Bom', parentPartField: 'part', bomIdField: 'id' },
      bomDetail: { object: 'SYN_BomLine', bomParentField: 'bom', componentIdField: 'part', quantityField: 'qty' },
    },
  }
}

// Only the database I/O is replaced. The real ledger mints content hashes,
// approves versions, advances generation and resolves the runtime pointer.
// This is not a concurrency/SQL-lock proof; the PostgreSQL suites cover that.
function memoryDb(scope) {
  let state = {
    [VERSION_TABLE]: [], [ACTIVATION_TABLE]: [], [AUDIT_TABLE]: [], [VALIDATION_TABLE]: [],
    integration_external_systems: [{
      id: 'plm_source_1', tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
      kind: 'data-source:sql-readonly', status: 'active', role: 'source',
      connection_id: 'synthetic-connection', config: {}, validation_revision: crypto.randomUUID(),
    }],
    [SOURCE_REVISION_TABLE]: [{ data_source_id: 'synthetic-connection', validation_revision: SOURCE_REVISION,
      tenant_id: scope.tenantId, workspace_id: scope.workspaceId, owner_id: 'binder-one', scope_kind: 'private',
      type: 'postgresql', is_active: true, deleted_at: null }],
  }
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value)
  function methods(data) {
    const selectOne = async (table, where) => clone(data[table].find((row) => matches(row, where)) || null)
    return {
      selectOne, selectOneForUpdate: selectOne, selectOneForKeyShare: selectOne,
      async select(table, { where = {}, orderBy, limit = 1000, offset = 0 } = {}) {
        const rows = data[table].filter((row) => matches(row, where))
        if (orderBy) rows.sort((left, right) => (left[orderBy[0]] - right[orderBy[0]]) * (orderBy[1] === 'DESC' ? -1 : 1))
        return clone(rows.slice(offset, offset + limit))
      },
      async insertOne(table, row) { data[table].push(clone(row)); return [clone(row)] },
      async updateRow(table, patch, where) {
        const row = data[table].find((candidate) => matches(candidate, where))
        if (!row) return []
        Object.assign(row, clone(patch))
        return [clone(row)]
      },
      async setTransactionIsolationLevel(level) { assert.equal(level, 'read committed') },
    }
  }
  return {
    ...Object.fromEntries(['select', 'selectOne', 'selectOneForUpdate', 'insertOne', 'updateRow']
      .map((name) => [name, (...args) => methods(state)[name](...args)])),
    async transaction(callback) {
      const working = clone(state)
      const result = await callback(methods(working))
      state = working
      return result
    },
  }
}

async function approved(maxReadCount = 100, scope = SCOPE, idPrefix = 'synthetic-id') {
  let nextId = 0
  const ledger = createStockPreparationReadPlanStore({
    db: memoryDb(scope), idGenerator: () => `${idPrefix}-${++nextId}`,
  })
  const saved = await ledger.saveVersion({ ...scope, actor: 'binder-one', config: config(maxReadCount) })
  // Ledger fixture only: synthetic measured counts isolate downstream identity
  // and budget tests. This helper is not evidence of a catalog/sample read;
  // validation-runtime and real-DB HTTP suites exercise that producer.
  const validationInput = { ...scope, id: saved.id, actor: 'binder-one',
    source: { connectionId: 'synthetic-connection', connectionRevision: SOURCE_REVISION } }
  const receipt = await ledger.beginValidation(validationInput)
  await ledger.finishValidation({ ...validationInput, validationId: receipt.validationId,
    counts: { sampleCount: 1, objectCount: 7, readCount: 1 } })
  await ledger.confirmValidation({ ...validationInput, validationId: receipt.validationId })
  await ledger.approve({ ...scope, id: saved.id, actor: 'binder-one' })
  await ledger.activate({ ...scope, id: saved.id, actor: 'binder-one', expectedGeneration: 0 })
  const load = () => ledger.getActiveForRuntime({ ...scope, actionId: ACTION_ID, systemId: 'plm_source_1' })
  return { ...(await load()), scope, ledger, load }
}

function storage() {
  const rows = new Map()
  return {
    durable: true,
    async get(key) { return clone(rows.get(key) || null) },
    async set(key, value) { rows.set(key, clone(value)) },
    async delete(key) { rows.delete(key) },
  }
}

function source() {
  const calls = []
  const data = {
    SYN_PathLink: [{ project: 'P-001', path: 'PATH-1' }],
    SYN_Path: [{ id: 'PATH-1' }],
    SYN_Order: [{ id: 'ORDER-1', path: 'PATH-1' }],
    SYN_OrderLine: [{ order: 'ORDER-1', part: 'PART-1', qty: '2' }],
    SYN_Part: [{ id: 'PART-1', code: 'SYN-001', name: 'Synthetic part' }],
    SYN_Bom: [], SYN_BomLine: [],
  }
  return {
    calls,
    async read(request) {
      calls.push(clone(request))
      assert.ok(Object.hasOwn(data, request.object), 'the activated plan selects the synthetic source objects')
      return {
        records: clone(data[request.object].filter((row) => Object.entries(request.filters || {}).every(([key, value]) => row[key] === value))),
        done: true, nextCursor: null,
      }
    },
  }
}

async function dryRun(action) {
  const adapter = source()
  const tokenStore = storage()
  const result = await dryRunStockPreparationAction({
    action, parameters: { projectNo: 'P-001' }, sourceAdapter: adapter,
    recordsApi: { async queryRecords() { return [] } }, tokenStore,
    plannedAt: '2026-09-30T00:00:00.000Z', runId: 'synthetic-run',
  })
  return { result, calls: adapter.calls, tokenStore }
}

function revision(action) {
  return buildRevision({
    action, parameters: { projectNo: 'P-001' },
    expansion: { status: 'ready', rows: [], errors: [], rowErrors: [] }, existingRows: [],
  })
}

test('real ledger approval and activation reach composition, repeated normalization and actual dry-run', async () => {
  const loaded = await approved()
  const input = baseAction({ source: { ...baseAction().source, workspaceId: 'old-connection-workspace' } })
  const before = clone(input)
  const action = composeStockPreparationReadPlanAction({ action: input, ...loaded })
  assert.deepEqual(input, before, 'composition does not mutate the deploy-time action')
  assert.deepEqual(action.readPlanExecutionIdentity, {
    ...SCOPE, actionId: ACTION_ID, systemId: 'plm_source_1',
    versionId: loaded.version.id, contentKey: loaded.version.contentKey, generation: 1,
  })
  assert.equal(action.source.workspaceId, 'old-connection-workspace', 'activation scope does not rewrite connection scope')
  assert.deepEqual(normalizeStockPreparationActionConfig(action), action)
  assert.deepEqual(assertStockPreparationTargetReady(JSON.parse(JSON.stringify(action))), action)
  const { result, calls } = await dryRun(action)
  assert.equal(result.canApply, true)
  assert.equal(typeof result.dryRunToken, 'string')
  assert.ok(calls.length > 2)
  assert.equal(calls[0].object, 'SYN_PathLink')
})

test('same approved content reactivated at a new generation invalidates real revisions and large-BOM contract', async () => {
  const loaded = await approved()
  const first = composeStockPreparationReadPlanAction({ action: baseAction(), ...loaded })
  await loaded.ledger.deactivate({ ...SCOPE, actionId: ACTION_ID, actor: 'binder-one', expectedGeneration: 1 })
  await loaded.ledger.activate({ ...SCOPE, id: loaded.version.id, actor: 'binder-one', expectedGeneration: 2 })
  const second = composeStockPreparationReadPlanAction({ action: baseAction(), scope: SCOPE, ...(await loaded.load()) })
  assert.equal(first.readPlanExecutionIdentity.contentKey, second.readPlanExecutionIdentity.contentKey)
  assert.equal(second.readPlanExecutionIdentity.generation, 3)
  assert.notEqual(revision(first), revision(second))
  assert.notEqual((await dryRun(first)).result.revision, (await dryRun(second)).result.revision)
  assert.throws(() => assertLargeBomActionExecutionContract(second, first), { code: 'TABLE_ACTION_LARGE_BOM_ACTION_CHANGED' })
  assert.doesNotThrow(() => assertLargeBomActionExecutionContract(second, clone(second)))
})

test('tenant, workspace and version identity each independently bind revision and large-BOM contract', async () => {
  const first = composeStockPreparationReadPlanAction({ action: baseAction(), ...(await approved()) })
  const cases = [
    ['tenantId', { ...SCOPE, tenantId: 'other-tenant' }, 'synthetic-id'],
    ['workspaceId', { ...SCOPE, workspaceId: 'other-workspace' }, 'synthetic-id'],
    ['versionId', SCOPE, 'other-version-id'],
  ]
  for (const [changedKey, scope, prefix] of cases) {
    const pair = await approved(100, changedKey === 'workspaceId' ? SCOPE : scope, prefix)
    if (changedKey === 'workspaceId') {
      // Composer contract only. The management ledger now deliberately rejects
      // workspace-scoped activation; do not forge such an approval in the DB.
      pair.scope = scope
      pair.activation = { ...pair.activation, workspaceId: scope.workspaceId }
      pair.version = { ...pair.version, workspaceId: scope.workspaceId }
    }
    const second = composeStockPreparationReadPlanAction({ action: baseAction(), ...pair })
    assert.deepEqual(Object.keys(first.readPlanExecutionIdentity).filter((key) =>
      first.readPlanExecutionIdentity[key] !== second.readPlanExecutionIdentity[key]), [changedKey])
    const { readPlanExecutionIdentity: _firstIdentity, ...firstExecution } = first
    const { readPlanExecutionIdentity: _secondIdentity, ...secondExecution } = second
    assert.deepEqual(firstExecution, secondExecution, 'no other effective action field can mask an omitted identity')
    assert.notEqual(revision(first), revision(second), changedKey)
    assert.throws(() => assertLargeBomActionExecutionContract(second, first), { code: 'TABLE_ACTION_LARGE_BOM_ACTION_CHANGED' })
  }
})

test('composition refuses wrong scope, source, action, pointer, digest and non-approved lifecycle', async () => {
  const loaded = await approved()
  const mutations = [
    (value) => { value.scope.tenantId = 'other' },
    (value) => { value.scope.workspaceId = 'other-workspace' },
    (value) => { delete value.scope.workspaceId },
    (value) => { value.activation.workspaceId = 'other-workspace' },
    (value) => { value.version.tenantId = 'other' },
    (value) => { value.action.source.externalSystemId = 'other' },
    (value) => { value.activation.actionId = 'other' },
    (value) => { value.version.actionId = 'other' },
    (value) => { value.activation.versionId = 'other' },
    (value) => { value.activation.contentKey = '0'.repeat(64) },
    (value) => { value.version.config.readPlan.part.nameField = 'other' },
    (value) => { value.version.contentKey = value.activation.contentKey = '0'.repeat(64) },
    (value) => { value.version.schemaVersion = 2 },
    (value) => { value.version.version = 0 },
    (value) => { value.version.status = 'draft' },
    (value) => { value.version.status = 'retired' },
    (value) => { value.activation.status = 'disabled' },
  ]
  for (const mutate of mutations) {
    const input = { action: baseAction(), scope: clone(SCOPE), activation: clone(loaded.activation), version: clone(loaded.version) }
    mutate(input)
    assert.throws(() => composeStockPreparationReadPlanAction(input), (error) => /^READ_PLAN_EXECUTION_/.test(error.code))
  }
  const tenantWide = await approved(100, { ...SCOPE, workspaceId: null })
  assert.equal(composeStockPreparationReadPlanAction({ action: baseAction(), ...tenantWide }).readPlanExecutionIdentity.workspaceId, null)
})

test('actual apply rejects a token minted before same-content reactivation and performs zero writes', async () => {
  const loaded = await approved()
  const first = composeStockPreparationReadPlanAction({ action: baseAction(), ...loaded })
  const prepared = await dryRun(first)
  await loaded.ledger.deactivate({ ...SCOPE, actionId: ACTION_ID, actor: 'binder-one', expectedGeneration: 1 })
  await loaded.ledger.activate({ ...SCOPE, id: loaded.version.id, actor: 'binder-one', expectedGeneration: 2 })
  const second = composeStockPreparationReadPlanAction({ action: baseAction(), scope: SCOPE, ...(await loaded.load()) })
  const adapter = source()
  let writes = 0
  const applyInput = {
    action: second, parameters: { projectNo: 'P-001' }, sourceAdapter: adapter,
    recordsApi: {
      async queryRecords() { return [] },
      async createRecord(input) { writes += 1; return { id: 'synthetic-row', ...input } },
      async patchRecord(input) { writes += 1; return { id: 'synthetic-row', ...input } },
    },
    permission: 'write', sandboxPolicy: { enabled: true, allowedTargetObjectIds: ['stockPreparationMain'] },
    plannedAt: '2026-09-30T00:00:00.000Z', runId: 'synthetic-run',
  }
  await assert.rejects(applyStockPreparationAction({
    ...applyInput, tokenStore: prepared.tokenStore, dryRunToken: prepared.result.dryRunToken,
  }), { code: 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH' })
  assert.equal(writes, 0)
  assert.ok(adapter.calls.length > 0, 'current contract permits source recomputation before token revision refusal')
  const fresh = await dryRun(second)
  await applyStockPreparationAction({
    ...applyInput, tokenStore: fresh.tokenStore, dryRunToken: fresh.result.dryRunToken,
  })
  assert.equal(writes, 1, 'a current-generation token can reach the actual writer through the same path')
})

test('normalizer rejects malformed or content-inconsistent execution identities instead of dropping them', async () => {
  const loaded = await approved()
  const action = composeStockPreparationReadPlanAction({ action: baseAction(), ...loaded })
  const mutations = [
    (id) => { id.extra = true },
    (id) => { delete id.workspaceId },
    (id) => { id.workspaceId = undefined },
    (id) => { id.tenantId = '' },
    (id) => { id.versionId = ' padded ' },
    (id) => { id.systemId = 'other' },
    (id) => { id.actionId = 'other' },
    (id) => { id.contentKey = '0'.repeat(64) },
    (id) => { id.contentKey = id.contentKey.toUpperCase() },
    (id) => { id.generation = 0 },
    (id) => { id.generation = -1 },
    (id) => { id.generation = '1' },
    (id) => { id.generation = 1.5 },
    (id) => { id.generation = 2147483648 },
    (id) => { id.generation = NaN },
    (id) => { id[Symbol('extra')] = true },
  ]
  for (const mutate of mutations) {
    const invalid = clone(action)
    mutate(invalid.readPlanExecutionIdentity)
    assert.throws(() => normalizeStockPreparationActionConfig(invalid), (error) => /^READ_PLAN_EXECUTION_/.test(error.code))
  }
  for (const identity of [undefined, null, [], 'identity']) {
    assert.throws(() => normalizeStockPreparationActionConfig({ ...action, readPlanExecutionIdentity: identity }))
  }
  const wrongPlan = clone(action)
  wrongPlan.source.readPlan.maxReadCount += 1
  assert.throws(() => assertStockPreparationTargetReady(wrongPlan), { code: 'READ_PLAN_EXECUTION_CONTENT_INVALID' })
})

test('approved budget bounds actual dry-run reads despite a higher invocation cap, and preserves lower caps', async () => {
  const loaded = await approved(2)
  for (const [configured, expected] of [[1000, 2], [1, 1], [undefined, 2]]) {
    const action = composeStockPreparationReadPlanAction({ action: baseAction({ maxReadCount: configured }), ...loaded })
    const { calls, result } = await dryRun(action)
    assert.equal(action.maxReadCount, expected)
    assert.equal(calls.length, expected)
    assert.equal(result.canApply, false)
    assert.equal(result.dryRunToken, null)
    assert.ok(result.evidence.expansion.errorTypes.includes('read_count_exceeded'))
  }
  const higherApproval = await approved(100)
  const lowerPreviousPlan = baseAction({ source: { ...baseAction().source, readPlan: config(2).readPlan } })
  const retained = composeStockPreparationReadPlanAction({ action: lowerPreviousPlan, ...higherApproval })
  assert.equal(retained.maxReadCount, 2)
  assert.equal(largeBomBackgroundExpansionCaps(retained).maxReadCount, 2)
})

test('background explicit caps and multipliers cannot exceed approval; lower existing background caps remain lower', async () => {
  const loaded = await approved(2)
  for (const [overrides, expected] of [
    [{ maxReadCount: 1000 }, 2],
    [{ maxReadCount: 1 }, 2],
    [{ largeBom: { maxReadCount: 1000 } }, 2],
    [{ largeBom: { maxReadCount: 1 } }, 1],
    [{}, 2],
  ]) {
    const action = composeStockPreparationReadPlanAction({ action: baseAction(overrides), ...loaded })
    const caps = largeBomBackgroundExpansionCaps(action)
    assert.equal(caps.maxReadCount, expected)
    const adapter = source()
    const jobStorage = storage()
    const jobScope = { ...SCOPE, workspaceId: 'execution-workspace' }
    const job = await createLargeBomBackgroundExpansionJob({ storage: jobStorage, ...jobScope, action, parameters: { projectNo: 'P-001' }, principal: 'operator-one' })
    const completed = await runLargeBomBackgroundExpansionJob({
      storage: jobStorage, ...jobScope, actionId: ACTION_ID, jobId: job.jobId,
      sourceAdapter: adapter, expansionOptions: { readPlan: action.source.readPlan, ...caps },
    })
    assert.equal(adapter.calls.length, expected)
    assert.equal(completed.authoritative, false)
  }
  const action = composeStockPreparationReadPlanAction({ action: baseAction(), ...loaded })
  action.largeBom = { maxReadCount: 1000 }
  assert.equal(largeBomBackgroundExpansionCaps(action).maxReadCount, 2, 'cap helper itself enforces the fence')
})

test('unactivated action preserves frozen legacy JSON shape, revision and background behavior', () => {
  // Captured from the production functions BEFORE this execution-identity
  // change, on b35d4cd1 plus the pre-existing SA01/SA02 working-tree changes.
  // They are not hashes derived from the expected output inside this test.
  const action = normalizeStockPreparationActionConfig(baseAction())
  assert.equal(Object.hasOwn(action, 'readPlanExecutionIdentity'), false)
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(action)).digest('hex'), '93126f51f8959440c8ded9b03248d5547fc54baaa41e706b96090c704159d6a4')
  assert.equal(revision(action), '3a8353308d906b0df87cd134eae12098ef172b9bd38cfcdce5f4b74ace2a6412')
  assert.equal(Object.hasOwn(largeBomBackgroundExpansionCaps(action), 'maxReadCount'), false)
  assert.equal(largeBomBackgroundExpansionCaps({ maxReadCount: 100 }).maxReadCount, 2000)
  assert.deepEqual(largeBomBackgroundExpansionCaps(null), largeBomBackgroundExpansionCaps({}))
})
