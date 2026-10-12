'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { validateStockPreparationReadPlanSample: validate, StockPreparationReadPlanValidationReadError } = require('../lib/stock-preparation-read-plan-validation-read.cjs')
const { READ_PLAN_ID, SOURCE_KIND } = require('../lib/stock-preparation-read-plan-config.cjs')
const {
  createB2aRegistry, createB2aOperationClaim, assertB2aReadAuthorization,
  B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION, SCHEMA_CONTRACT_KEY_PREFIX,
} = require('../lib/b2a-trial-registry.cjs')

const ACTION = 'plm.stock-preparation.pull-bom.v1'
const PROJECT = 'SYN-PROJECT'
const PRIVATE = 'SYN-private-driver-value'
const clone = (value) => structuredClone(value)
const PHYSICAL = {
  'syn.pathlinks': ['project', 'path'], 'syn.pathinfo': ['id'],
  'syn.orderheads': ['id', 'path'], 'syn.orderlines': ['orderid', 'part', 'qty', 'sort', 'bomver'],
  'syn.parts': ['id', 'code', 'name', 'material', 'ver', 'spec'],
  'syn.bomheads': ['part', 'id', 'ver', 'active'], 'syn.bomlines': ['bom', 'part', 'qty', 'sort'],
}
function config() {
  return { schemaVersion: 1, actionId: ACTION, systemId: 'synthetic-source', readPlan: {
    id: READ_PLAN_ID, sourceKind: SOURCE_KIND, matchField: 'project', maxReadCount: 100,
    pathExAttr: { object: 'syn.pathlinks', matchField: 'project', pathIdField: 'path' },
    pathInfo: { object: 'syn.pathinfo', idField: 'id' },
    orderHead: { object: 'syn.orderheads', idField: 'id', pathIdField: 'path' },
    orderDetail: { object: 'syn.orderlines', orderIdField: 'orderid', componentIdField: 'part', quantityField: 'qty', sortField: 'sort', versionField: 'bomver' },
    part: { object: 'syn.parts', idField: 'id', codeField: 'code', nameField: 'name', materialField: 'material', versionField: 'ver', specField: 'spec' },
    bomHead: { object: 'syn.bomheads', parentPartField: 'part', bomIdField: 'id', versionField: 'ver', activeField: 'active' },
    bomDetail: { object: 'syn.bomlines', bomParentField: 'bom', componentIdField: 'part', quantityField: 'qty', sortField: 'sort' },
  } }
}
function data() {
  return {
    'syn.pathlinks': [{ project: PROJECT, path: 'PATH' }],
    'syn.pathinfo': [{ id: 'PATH' }], 'syn.orderheads': [{ id: 'ORDER', path: 'PATH' }],
    'syn.orderlines': [{ orderid: 'ORDER', part: 'ROOT', qty: 2, sort: 0, bomver: 'B2' }],
    'syn.parts': [
      { id: 'ROOT', code: 'ROOT-CODE', name: 'Root part', material: 'Steel', ver: 'P1', spec: 'Spec', secretcell: PRIVATE, ext_hidden: PRIVATE },
      { id: 'CHILD', code: 'CHILD-CODE', name: 'Child part', material: false, ver: 'P1' },
    ],
    'syn.bomheads': [{ part: 'ROOT', id: 'BOM', ver: 'B2', active: true }],
    'syn.bomlines': [{ bom: 'BOM', part: 'CHILD', qty: 3, sort: 0 }],
  }
}
// Controlled synthetic SQL-adapter boundary only. The production catalog
// inspector, expander, version selection and B2a guards are NOT mocked.
function fixture() {
  const saved = config()
  const active = clone(saved.readPlan)
  active.part.object = 'syn.activeparts'
  const input = {
    config: saved, action: { actionId: ACTION, source: { kind: SOURCE_KIND, externalSystemId: saved.systemId, readPlan: active }, rootSelection: { enabled: false } },
    projectNo: `  ${PROJECT}  `, dialect: 'postgresql',
  }
  const state = { data: data(), schema: clone(PHYSICAL), reads: [], schemas: [], schemaHook: null, readHook: null, writes: 0 }
  state.data['syn.activeparts'] = state.data['syn.parts'].map((row) => ({ ...row, code: 'ACTIVE-CODE' }))
  input.sourceAdapter = {
    kind: SOURCE_KIND,
    async getSchema(request) {
      state.schemas.push(clone(request))
      if (state.schemaHook) return state.schemaHook(request, state.schemas.length)
      return { object: request.object, fields: (state.schema[request.object] || []).map((name) => ({ name, type: 'text', nullable: false })) }
    },
    async read(request) {
      state.reads.push(clone(request))
      if (state.readHook) return state.readHook(request)
      const rows = (state.data[request.object] || []).filter((row) => Object.entries(request.filters).every(([key, value]) => String(row[key]) === String(value)))
      const offset = Number(request.cursor || 0)
      const records = clone(rows.slice(offset, offset + request.limit))
      const done = offset + records.length >= rows.length
      return { records, done, nextCursor: done ? null : String(offset + records.length) }
    },
    async upsert() { state.writes++; throw new Error('unexpected target operation') },
  }
  return { input, state }
}
async function rejects(input, code, run = validate) {
  await assert.rejects(() => run(input), (error) => {
    assert.equal(error.name, 'StockPreparationReadPlanValidationReadError')
    assert.equal(error.code, code)
    assert.equal(error.message, code)
    assert.equal(error.details, undefined)
    assert.doesNotMatch(JSON.stringify(error), /SYN-private|driver-value/)
    return true
  })
}
async function arm(input, extraObjects = []) {
  const now = Date.parse('2026-09-01T12:00:00Z')
  const objects = [...Object.values(input.config.readPlan).filter((value) => value && typeof value === 'object').map((role) => role.object), ...extraObjects]
  const store = new Map()
  const claimRows = new Map()
  const operationClaim = createB2aOperationClaim({ db: {
    async insertOne(_table, row) { claimRows.set(row.claim_key, clone(row)); return [clone(row)] },
    async selectOne(_table, where) { return clone(claimRows.get(where.claim_key) || null) },
  } })
  const registry = createB2aRegistry({ config: { b2aTrialRegistry: {
    registryId: 'synthetic-validation', registryVersion: 1,
    registrations: [{
      registrationId: 'synthetic-validation-read', registrationVersion: 1,
      tenantScope: 'synthetic-tenant', sourceSystemType: SOURCE_KIND, sourceBindingRef: input.config.systemId,
      projectDataScope: { dataScopeRefs: [PROJECT] }, objectScope: { sourceObjects: objects },
      purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION, ownerPrincipalRef: 'synthetic-owner',
      authorizationRef: 'synthetic-authorization', operationRef: 'synthetic-operation',
      effectiveAt: '2026-09-01T00:00:00Z', expiresAt: '2026-09-02T00:00:00Z',
      forbidReuse: true, sourceReadOperationLimit: 1, artifactReplayLimit: 0,
      consumptionState: 'unconsumed', consumedAt: null, b2bMigrationCondition: 'synthetic local validation only',
      expiryHandling: 'deny_replay', status: 'active',
    }],
  } } })
  const authorization = await assertB2aReadAuthorization({
    registry, store, operationClaim, tenantScope: 'synthetic-tenant', sourceSystemType: SOURCE_KIND,
    sourceBindingRef: input.config.systemId, dataScopeRef: PROJECT, sourceObjects: objects,
    purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION, runId: 'synthetic-run', now,
  })
  Object.assign(input, { b2aTrialRegistration: authorization, b2aClaimStore: store, b2aSourceObjects: objects, b2aNow: now })
  return store
}

test('saved draft A, not action active B, drives real catalog and versioned BOM expansion', async () => {
  const { input, state } = fixture()
  const before = clone({ config: input.config, action: input.action, data: state.data })
  const result = await validate(input)
  assert.deepEqual(result.catalog, { status: 'matched', validation: 'physical-columns-only', authorizesExecution: false, issues: [] })
  assert.equal(result.status, 'sample_ready')
  assert.equal(result.sample.totalRows, 2)
  assert.equal(result.sample.rows[1].totalQuantity, 6)
  assert.equal(result.sample.rows[1].parentSourceId, 'ROOT')
  assert.equal(result.sample.rows[0].sourceVersion, 'P1')
  assert.equal(result.sample.rows[0].orderBomVersion, 'B2')
  assert.equal(Object.hasOwn(result.sample.rows[1], 'orderBomVersion'), false)
  assert.ok(state.reads.some((read) => read.object === 'syn.bomheads' && read.filters.part === 'ROOT' && read.filters.ver === 'B2'))
  assert.ok(state.reads.some((read) => read.object === 'syn.bomheads' && read.filters.part === 'CHILD' && read.filters.ver === 'P1'))
  assert.ok(state.reads.every((read) => read.object !== 'syn.activeparts'))
  assert.deepEqual(state.schemas.map((read) => read.object), Object.keys(PHYSICAL))
  assert.equal(result.canApply, false)
  assert.equal(result.tokenIssued, false)
  assert.equal(result.authorizesExecution, false)
  assert.equal(result.dryRunToken, undefined)
  assert.equal(state.writes, 0)
  assert.equal(result.evidence.readCount, state.reads.length)
  assert.deepEqual({ config: input.config, action: input.action, data: state.data }, before)
  assert.doesNotMatch(JSON.stringify(result), /secretcell|ext_hidden|SYN-private|syn\.parts/)
  assert.doesNotMatch(JSON.stringify(result.evidence), /ROOT|CHILD|Steel|SYN-PROJECT/)
  assert.equal(result.evidence.sampleCount, 2)
})

test('legacy sample omits order BOM version instead of inventing the material version', async () => {
  const { input, state } = fixture()
  delete input.config.readPlan.orderDetail.versionField
  state.data['syn.bomheads'][0].ver = 'P1'
  const result = await validate(input)
  assert.equal(result.sample.rows.length, 2)
  assert.ok(result.sample.rows.every(row => !Object.hasOwn(row, 'orderBomVersion')))
  assert.equal(result.sample.rows[0].sourceVersion, 'P1')
})

for (const version of [0, '0', ' V02 ']) test(`sample preserves the declared order version type: ${JSON.stringify(version)}`, async () => {
  const { input, state } = fixture()
  state.data['syn.orderlines'][0].bomver = version
  state.data['syn.bomheads'][0].ver = typeof version === 'string' ? version.trim() : version
  const result = await validate(input)
  assert.equal(result.sample.rows[0].orderBomVersion, typeof version === 'string' ? version.trim() : version)
  assert.equal(result.sample.rows[0].sourceVersion, 'P1')
  assert.equal(Object.hasOwn(result.sample.rows[1], 'orderBomVersion'), false)
  assert.equal(result.sample.rows[1].totalQuantity, 6)
})

for (const version of [null, undefined, '', '  ', false, { value: 'B2' }]) test(`invalid order version never becomes a successful sample: ${JSON.stringify(version)}`, async () => {
  const { input, state } = fixture()
  state.data['syn.orderlines'][0].bomver = version
  await rejects(input, 'READ_PLAN_VALIDATION_INCOMPLETE')
})

for (const [requested, actual] of [[0, '0'], ['0', 0], ['B2', 'P1']]) test(`order version mismatch stays closed: ${JSON.stringify([requested, actual])}`, async () => {
  const { input, state } = fixture()
  state.data['syn.orderlines'][0].bomver = requested
  state.data['syn.bomheads'][0].ver = actual
  await rejects(input, 'READ_PLAN_VALIDATION_INCOMPLETE')
})

for (const dialect of ['postgres', 'sqlserver']) test(`direct ${dialect} sample preserves measured zero and boolean cells`, async () => {
  const { input, state } = fixture()
  input.dialect = dialect
  state.data['syn.bomlines'][0].qty = 0
  const result = await validate(input)
  assert.equal(result.sample.rows[1].rawQuantity, 0)
  assert.equal(result.sample.rows[1].totalQuantity, 0)
  assert.equal(result.sample.rows[1].material, false)
  assert.equal(result.sample.rows[1].sortLine, 0)
  assert.equal(result.sample.rows[0].depth, 0)
  assert.deepEqual(Object.keys(result.sample.rows[1]).sort(), ['componentSourceId', 'parentSourceId', 'path', 'depth', 'componentCode', 'componentName', 'material', 'sourceVersion', 'rawQuantity', 'totalQuantity', 'active', 'spec', 'sortLine'].sort())
})

test('bounded display does not truncate the complete expansion or counts', async () => {
  const { input, state } = fixture()
  state.data['syn.bomlines'] = []
  for (let i = 0; i < 25; i++) {
    state.data['syn.parts'].push({ id: `C${i}`, code: `CODE${i}`, name: `Item ${i}`, ver: 'P1' })
    state.data['syn.bomlines'].push({ bom: 'BOM', part: `C${i}`, qty: i, sort: i })
  }
  const result = await validate(input)
  assert.equal(result.sample.totalRows, 26)
  assert.equal(result.sample.displayedRows, 20)
  assert.equal(result.sample.rows.length, 20)
  assert.equal(result.sample.truncated, true)
  assert.equal(result.evidence.complete, true)
  assert.equal(result.evidence.rowCount, 26)
})

for (const [label, change] of [
  ['wrong action', (input) => { input.action.actionId = 'another-action' }],
  ['wrong binding', (input) => { input.action.source.externalSystemId = 'another-source' }],
  ['Bridge', (input) => { input.action.source.kind = 'bridge:legacy-sql-readonly' }],
  ['Bridge adapter', (input) => { input.sourceAdapter.kind = 'bridge:legacy-sql-readonly' }],
  ['unknown dialect', (input) => { input.dialect = 'mysql' }],
  ['blank project', (input) => { input.projectNo = '  ' }],
  ['oversized project', (input) => { input.projectNo = 'x'.repeat(129) }],
  ['control project', (input) => { input.projectNo = 'x\ny' }],
  ['coerced limit', (input) => { input.action.maxReadCount = '50' }],
  ['zero limit', (input) => { input.action.maxPages = 0 }],
  ['malformed root rule', (input) => { input.action.rootSelection = { surprise: true } }],
]) test(`${label} refuses before any schema or row read`, async () => {
  const { input, state } = fixture()
  change(input)
  await rejects(input, 'READ_PLAN_VALIDATION_INPUT_INVALID')
  assert.deepEqual([state.schemas.length, state.reads.length], [0, 0])
})

test('null input is a coarse validation error', async () => {
  await assert.rejects(() => validate(null), StockPreparationReadPlanValidationReadError)
})

for (const [label, change] of [
  ['missing physical field', (input, state) => { state.schema['syn.parts'] = ['id'] }],
  ['configured wrong schema', (input) => { input.config.readPlan.part.object = 'other.parts' }],
  ['unqualified object', (input) => { input.config.readPlan.part.object = 'parts' }],
  ['mismatched descriptor object', (_input, state) => { state.schemaHook = () => ({ object: 'other.parts', fields: [{ name: 'id' }] }) }],
  ['missing descriptor object', (_input, state) => { state.schemaHook = () => ({ fields: [{ name: 'id' }] }) }],
  ['malformed descriptor fields', (_input, state) => { state.schemaHook = (req) => ({ object: req.object, fields: [null] }) }],
  ['oversized descriptor', (_input, state) => { state.schemaHook = (req) => ({ object: req.object, fields: Array.from({ length: 4097 }, () => ({ name: 'id' })) }) }],
]) test(`${label} cannot probe BOM rows`, async () => {
  const { input, state } = fixture()
  change(input, state)
  await rejects(input, 'READ_PLAN_VALIDATION_CATALOG_UNVERIFIED')
  assert.equal(state.reads.length, 0)
})

test('catalog driver error and arbitrary code are not echoed', async () => {
  const { input, state } = fixture()
  state.schemaHook = () => { throw Object.assign(new Error(PRIVATE), { code: 'B2A_SCHEMA_DRIFT' }) }
  await rejects(input, 'READ_PLAN_VALIDATION_SOURCE_FAILED')
  assert.equal(state.reads.length, 0)
})

for (const [label, change] of [
  ['not found', (_input, state) => { state.data['syn.pathlinks'] = [] }],
  ['empty project', (_input, state) => { state.data['syn.orderlines'] = [] }],
  ['missing part', (_input, state) => { state.data['syn.parts'].pop() }],
  ['missing child BOM', (_input, state) => { state.data['syn.bomlines'] = [] }],
  ['invalid quantity', (_input, state) => { state.data['syn.bomlines'][0].qty = null }],
  ['unmatched BOM version', (_input, state) => { state.data['syn.bomheads'][0].ver = 'OLD' }],
  ['ambiguous BOM version', (_input, state) => { state.data['syn.bomheads'].push({ part: 'ROOT', id: 'OTHER', ver: 'B2', active: true }) }],
  ['conflicting BOM versions', (_input, state) => { state.data['syn.orderlines'].push({ orderid: 'ORDER', part: 'ROOT', qty: 2, bomver: 'OTHER' }) }],
  ['nested projected value', (_input, state) => { state.data['syn.parts'][0].material = { private: PRIVATE } }],
  ['numeric multiplication overflow', (_input, state) => { state.data['syn.orderlines'][0].qty = 1e308; state.data['syn.bomlines'][0].qty = 1e308 }],
  ['truncated row errors', (input, state) => { input.action.rowErrorLimit = 1; state.data['syn.bomlines'] = [{ bom: 'BOM', part: 'X', qty: 1 }, { bom: 'BOM', part: 'Y', qty: 1 }] }],
  ['root semantics retained', (input, state) => { input.action.rootSelection = {}; state.data['syn.orderlines'].push({ orderid: 'ORDER', part: 'MAIN', qty: 1, bomver: 'B2' }); state.data['syn.parts'].push({ id: 'MAIN', code: 'J1-00', ver: 'P1' }) }],
]) test(`${label} cannot certify a complete nonempty sample`, async () => {
  const { input, state } = fixture()
  change(input, state)
  await rejects(input, 'READ_PLAN_VALIDATION_INCOMPLETE')
  assert.equal(state.writes, 0)
})

for (const [label, page] of [
  ['broken cursor', { records: [], done: false, nextCursor: null }],
  ['legacy unproven page', { records: [] }],
  ['contradictory terminal cursor', { records: [], done: true, nextCursor: '1' }],
  ['malformed row', { records: [null], done: true }],
]) test(`${label} stays incomplete through the real expander`, async () => {
  const { input, state } = fixture()
  state.readHook = () => clone(page)
  await rejects(input, 'READ_PLAN_VALIDATION_INCOMPLETE')
  assert.equal(state.reads.length, 1)
})

for (const budgetSource of ['draft', 'action']) test(`${budgetSource} read budget is enforced even when the other budget is larger`, async () => {
  const { input, state } = fixture()
  input.config.readPlan.maxReadCount = budgetSource === 'draft' ? 1 : 100
  input.action.maxReadCount = budgetSource === 'action' ? 1 : 100
  await rejects(input, 'READ_PLAN_VALIDATION_INCOMPLETE')
  assert.equal(state.reads.length, 1)
})

test('page and row caps preserve incomplete status', async () => {
  for (const limits of [{ pageLimit: 1, maxPages: 1 }, { maxRows: 1 }, { maxDepth: 0 }]) {
    const { input, state } = fixture()
    Object.assign(input.action, limits)
    if (limits.maxPages) state.data['syn.pathlinks'].push({ project: PROJECT, path: 'PATH2' })
    await rejects(input, 'READ_PLAN_VALIDATION_INCOMPLETE')
  }
})

test('total deadline stops later probes but does not claim to cancel an in-flight schema call', async () => {
  const { input, state } = fixture()
  input.action.maxElapsedMs = 50
  let settle
  state.schemaHook = () => new Promise((resolve) => { settle = resolve })
  await rejects(input, 'READ_PLAN_VALIDATION_TIMEOUT')
  assert.equal(state.schemas.length, 1)
  settle({ object: 'syn.pathlinks', fields: PHYSICAL['syn.pathlinks'].map((name) => ({ name })) })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.schemas.length, 1)
  assert.equal(state.reads.length, 0)
})

test('real B2a schema guards share the supplied list including hidden lookup object', async () => {
  const { input, state } = fixture()
  state.schema['syn.lookup'] = ['id', 'label']
  await arm(input, ['syn.lookup'])
  const result = await validate(input)
  assert.equal(result.status, 'sample_ready')
  assert.equal(state.schemas.filter((call) => call.object === 'syn.lookup').length, 2)
  assert.equal(state.schemas.length, 7 + 8 + 8)
})

test('armed omitted draft object refuses before catalog; no inferred replacement list', async () => {
  const { input, state } = fixture()
  await arm(input)
  input.b2aSourceObjects = input.b2aSourceObjects.slice(1)
  await rejects(input, 'READ_PLAN_VALIDATION_INPUT_INVALID')
  assert.equal(state.schemas.length, 0)
})

test('armed missing claim store refuses before any schema work', async () => {
  const { input, state } = fixture()
  await arm(input)
  delete input.b2aClaimStore
  await rejects(input, 'READ_PLAN_VALIDATION_INPUT_INVALID')
  assert.equal(state.schemas.length, 0)
})

test('real B2a budget and schema-change refusals remain fixed coarse codes', async () => {
  const bounded = fixture()
  await arm(bounded.input)
  bounded.input.config.readPlan.maxReadCount = 1
  await rejects(bounded.input, 'B2A_PAGE_LIMIT_EXCEEDED')
  const drift = fixture()
  await arm(drift.input)
  drift.state.schemaHook = (req, count) => ({ object: req.object, fields: PHYSICAL[req.object].map((name) => ({ name, type: count > 14 ? 'changed' : 'text' })) })
  await rejects(drift.input, 'C6_FULL_BATCH_INCOMPLETE')
})

// Single source edits compiled only in memory. Every witness first exercises
// the real production check and then kills one relaxed source seam; dependencies
// still resolve to the real catalog/expander/B2a modules, not stubs.
function mutate(needle, replacement) {
  const filename = require.resolve('../lib/stock-preparation-read-plan-validation-read.cjs')
  const source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n')
  assert.equal(source.split(needle).length, 2, 'exactly one mutation hit')
  const copy = new Module(filename, module)
  copy.filename = filename
  copy.paths = Module._nodeModulePaths(path.dirname(filename))
  copy._compile(source.replace(needle, replacement), filename)
  return copy.exports.validateStockPreparationReadPlanSample
}
test('mutation: losing the order version projection hides the version actually selected by the expander', async () => {
  const mutant = mutate("'sourceVersion', 'orderBomVersion',", "'sourceVersion',")
  const { input } = fixture()
  const invariant = async (implementation) => {
    const result = await implementation(input)
    assert.equal(result.sample.rows[0].sourceVersion, 'P1')
    assert.equal(result.sample.rows[0].orderBomVersion, 'B2')
    assert.equal(Object.hasOwn(result.sample.rows[1], 'orderBomVersion'), false)
  }
  await invariant(validate)
  await assert.rejects(() => invariant(mutant), { code: 'ERR_ASSERTION' })
})

test('mutation: losing saved-plan wiring is caught by actual source-object calls', async () => {
  const mutant = mutate('readPlan: config.readPlan, ...limits', 'readPlan: action.source.readPlan, ...limits')
  const { input, state } = fixture()
  const invariant = async (implementation) => {
    const result = await implementation(input)
    assert.equal(result.status, 'sample_ready')
    assert.equal(result.sample.rows[0].componentCode, 'ROOT-CODE')
  }
  await invariant(validate)
  await assert.rejects(() => invariant(mutant), { code: 'ERR_ASSERTION' })
  assert.ok(state.reads.some((read) => read.object === 'syn.activeparts'))
})
test('mutation: removing catalog refusal admits a physically missing optional field', async () => {
  const mutant = mutate("if (catalog.status !== 'matched') refuse('READ_PLAN_VALIDATION_CATALOG_UNVERIFIED')", 'void catalog')
  const { input, state } = fixture()
  state.schema['syn.parts'] = state.schema['syn.parts'].filter((name) => name !== 'spec')
  await rejects(input, 'READ_PLAN_VALIDATION_CATALOG_UNVERIFIED')
  assert.equal((await mutant(input)).status, 'sample_ready')
})
test('mutation: losing draft budget fails the actual read-count assertion', async () => {
  const mutant = mutate('limits.maxReadCount = Math.min(limits.maxReadCount, config.readPlan.maxReadCount)', 'void config')
  const { input } = fixture()
  input.config.readPlan.maxReadCount = 1
  await rejects(input, 'READ_PLAN_VALIDATION_INCOMPLETE')
  assert.equal((await mutant(input)).status, 'sample_ready')
})
test('mutation: bypassing semantic readiness certifies an actually missing child', async () => {
  const mutant = mutate("if (!completeExpansion(expansion)) refuse('READ_PLAN_VALIDATION_INCOMPLETE', 409)", 'void completeExpansion')
  const { input, state } = fixture()
  state.data['syn.parts'].pop()
  await rejects(input, 'READ_PLAN_VALIDATION_INCOMPLETE')
  assert.equal((await mutant(input)).status, 'sample_ready')
})
test('mutation: bypassing B2a pre-pin accepts a stale stored schema contract', async () => {
  const needle = 'const contract = await assertB2aSchemaContract({\n      store: b2aClaimStore, authorization: b2aTrialRegistration, sourceAdapter: adapter,\n      sourceObjects: b2aSourceObjects, now: b2aNow,\n    })'
  const mutant = mutate(needle, 'const contract = null')
  const { input } = fixture()
  const store = await arm(input)
  await validate(input)
  for (const [key, value] of store) if (key.startsWith(SCHEMA_CONTRACT_KEY_PREFIX)) store.set(key, { ...value, schemaContractVersion: -1 })
  await rejects(input, 'B2A_SCHEMA_DRIFT')
  assert.equal((await mutant(input)).status, 'sample_ready')
})
test('mutation: bypassing B2a post-schema accepts drift after a real complete expansion', async () => {
  const needle = 'await assertB2aSourceUnchangedAfterRead({\n      authorization: b2aTrialRegistration, contract, sourceAdapter: adapter, sourceObjects: b2aSourceObjects,\n    })'
  const mutant = mutate(needle, 'void contract')
  const run = async (implementation) => {
    const { input, state } = fixture()
    await arm(input)
    state.schemaHook = (req, count) => ({ object: req.object, fields: PHYSICAL[req.object].map((name) => ({ name, type: count > 14 ? 'changed' : 'text' })) })
    return implementation(input)
  }
  await assert.rejects(() => run(validate), { code: 'C6_FULL_BATCH_INCOMPLETE' })
  assert.equal((await run(mutant)).status, 'sample_ready')
})

test('mutation: losing B2a full-batch classification is not masked by the generic completeness check', async () => {
  const mutant = mutate('assertB2aFullBatchComplete(b2aTrialRegistration, expansion.errors)', 'void expansion.errors')
  const { input } = fixture()
  await arm(input)
  input.config.readPlan.maxReadCount = 1
  await rejects(input, 'B2A_PAGE_LIMIT_EXCEEDED')
  await rejects(input, 'READ_PLAN_VALIDATION_INCOMPLETE', mutant)
})

test('catalog deduplicates physical objects and checks the union of all role columns', async () => {
  const { input, state } = fixture()
  input.config.readPlan.pathInfo.object = 'syn.orderheads'
  state.data['syn.orderheads'].push({ id: 'PATH' })
  const result = await validate(input)
  assert.equal(result.evidence.objectCount, 6)
  assert.equal(state.schemas.length, 6)
  assert.equal(result.sample.totalRows, 2)
})

test('driver failure inside a row read is incomplete and never echoes its error payload', async () => {
  const { input, state } = fixture()
  state.readHook = () => { throw Object.assign(new Error(PRIVATE), { code: PRIVATE }) }
  await rejects(input, 'READ_PLAN_VALIDATION_INCOMPLETE')
  assert.equal(state.reads.length, 1)
})

test('armed schema timeout keeps real B2a classification without raw driver text', async () => {
  const { input, state } = fixture()
  await arm(input)
  state.schemaHook = () => { throw Object.assign(new Error(PRIVATE), { code: 'ETIMEDOUT' }) }
  await rejects(input, 'B2A_SOURCE_TIMEOUT')
  assert.equal(state.reads.length, 0)
})

test('late row read settlement cannot start the next page or BOM role', async () => {
  const { input, state } = fixture()
  input.action.maxElapsedMs = 50
  let settle
  state.readHook = () => new Promise((resolve) => { settle = resolve })
  await rejects(input, 'READ_PLAN_VALIDATION_TIMEOUT')
  assert.equal(state.reads.length, 1)
  settle({ records: [{ project: PROJECT, path: 'PATH' }], done: false, nextCursor: '1' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.reads.length, 1)
})

test('B2a pre and post-schema probes use the same bounded wrapper', async () => {
  for (const stalledCall of [8, 15]) {
    const { input, state } = fixture()
    await arm(input)
    input.action.maxElapsedMs = 50
    let settle
    state.schemaHook = (req, count) => count === stalledCall
      ? new Promise((resolve) => { settle = () => resolve({ object: req.object, fields: PHYSICAL[req.object].map((name) => ({ name })) }) })
      : { object: req.object, fields: PHYSICAL[req.object].map((name) => ({ name })) }
    await rejects(input, 'READ_PLAN_VALIDATION_TIMEOUT')
    const readCount = state.reads.length
    settle()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(state.schemas.length, stalledCall)
    assert.equal(state.reads.length, readCount)
    assert.equal(readCount > 0, stalledCall === 15)
  }
})

test('oversized source page fails before it can become a successful sample', async () => {
  const { input, state } = fixture()
  input.action.pageLimit = 1
  state.readHook = () => ({ records: [{ project: PROJECT, path: 'PATH' }, { project: PROJECT, path: 'PATH' }], done: true })
  await rejects(input, 'READ_PLAN_VALIDATION_INCOMPLETE')
  assert.equal(state.reads.length, 1)
})
