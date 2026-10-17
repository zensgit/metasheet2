'use strict'

// Real registry -> canonical resolver -> SQL adapter -> B2a -> BOM/planner.
// Only storage/facade/record IO is synthetic. No credentials, sockets, DB or writes.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createStockPreparationAutomationPreview, StockPreparationAutomationPreviewError } = require('../lib/stock-preparation-automation-preview.cjs')
const { createExternalSystemRegistry } = require('../lib/external-systems.cjs')
const { createConnectionResolver } = require('../lib/connection-resolver.cjs')
const { createAdapterRegistry } = require('../lib/contracts.cjs')
const { createDataSourceSqlReadonlySourceAdapterFactory } = require('../lib/adapters/data-source-sql-readonly-source-adapter.cjs')
const { normalizeStockPreparationActionConfig } = require('../lib/stock-preparation-table-actions.cjs')
const { deriveAutomationReadTargetContract } = require('../lib/stock-preparation-automation-target-contract.cjs')
const { restoreStockPreparationAutomationProfileMaterial } = require('../lib/stock-preparation-automation-profile.cjs')
const { normalizeCustomerPack } = require('../lib/stock-preparation-customer-pack.cjs')
const { FACTORY_A_REHEARSAL_PACK } = require('../lib/customer-packs/factory-a.rehearsal.cjs')
const { __internals: { buildExtensionFieldProperty } } = require('../lib/stock-preparation-customer-pack-installer.cjs')
const {
  createB2aRegistry, createB2aOperationClaim, readPlanSourceObjects,
  B2A_OPERATION_CLAIM_TABLE, B2A_PURPOSE_STOCK_PREPARATION_AUTOMATION_PREVIEW,
  B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
} = require('../lib/b2a-trial-registry.cjs')

const clone = value => JSON.parse(JSON.stringify(value))
const KIND = 'data-source:sql-readonly'
const CONNECTION_REVISION = '11111111-1111-4111-8111-111111111111'
const BINDING_REVISION = '22222222-2222-4222-8222-222222222222'
const privateDetail = 'synthetic-private-cell-or-driver-detail'
function memory() {
  const values = new Map()
  return { values, async get(key) { return values.get(key) ?? null }, async set(key, value) { values.set(key, clone(value)) } }
}
function sourceData() {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: 'P-001', Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2' }],
    DN_PDM_PartLibraryInfo: [{ OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1', SyntheticSpec: privateDetail }],
    DN_PDM_BomHeadInfo: [], DN_PDM_BomDetailsInfo: [],
  }
}
function fixture({ purpose = B2A_PURPOSE_STOCK_PREPARATION_AUTOMATION_PREVIEW, pack = false, role = 'source' } = {}) {
  const events = [], data = sourceData(), existing = []
  const state = { beforeMetadata: null, beforeResolve: null, beforeSelect: null, beforeClaimStore: null,
    afterSelect: null, afterSchema: null, afterRecords: null, beforeCheckpoint: null, pendingSelect: null }
  const actor = { actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null }
  const row = { id: 'synthetic-system', tenant_id: actor.tenantId, workspace_id: null, connection_id: 'synthetic-connection',
    validation_revision: BINDING_REVISION, name: 'Synthetic', kind: KIND, role, status: 'active',
    config: {}, credentials_encrypted: null, created_at: '2026-10-01T00:00:00.000Z' }
  let gets = 0, nativeReads = 0
  const noWrite = () => { events.push('business-write'); throw new Error('Business write must never occur') }
  const db = { async selectOne(table, where) {
    assert.equal(table, 'integration_external_systems')
    assert.deepEqual(where, { tenant_id: actor.tenantId, workspace_id: null, id: row.id })
    gets++
    events.push(gets === 1 ? 'metadata' : gets === 2 ? 'config' : 'binding')
    if (gets === 1 && state.beforeMetadata) await state.beforeMetadata(row)
    if (gets === 3 && state.beforeResolve) state.beforeResolve(row)
    return clone(row)
  }, insertOne: noWrite, updateRow: noWrite, select: noWrite, deleteRows: noWrite, countRows: noWrite }
  const facade = {
    async resolveConnectionRegistration(id, context) {
      events.push('resolve')
      assert.equal(id, row.connection_id)
      assert.deepEqual(context, { tenantId: actor.tenantId, workspaceId: null, principal: actor.actorId, runAs: 'user' })
      return { id, tenantId: actor.tenantId, type: 'postgres', scopeKind: 'private' }
    },
    async test() { throw new Error('No connection test') },
    async getSchema() { throw new Error('No unrestricted schema enumeration') },
    async getTableInfo(id, table, principal, schema, validation) {
      events.push('schema')
      assert.equal(id, 'synthetic-connection'); assert.equal(principal, actor.actorId)
      assert.equal(schema, undefined); assert.deepEqual(validation, { expectedValidationRevision: CONNECTION_REVISION })
      const columns = [...new Set((data[table] || []).flatMap(Object.keys))].map(name => ({ name, type: 'string', nullable: false }))
      if (state.afterSchema) state.afterSchema(table)
      return { columns }
    },
    async select(id, object, options, principal, armed, validation) {
      events.push('select'); nativeReads++
      assert.equal(id, 'synthetic-connection'); assert.equal(principal, actor.actorId); assert.equal(armed, true)
      assert.deepEqual(validation, { expectedValidationRevision: CONNECTION_REVISION })
      if (state.beforeSelect) await state.beforeSelect()
      if (state.pendingSelect) await state.pendingSelect
      const rows = (data[object] || []).filter(record => Object.entries(options.where || {}).every(([key, value]) => record[key] === value))
        .slice(options.offset || 0, (options.offset || 0) + options.limit)
      if (state.afterSelect) state.afterSelect(object)
      return { data: clone(rows) }
    },
  }
  const externalSystems = createExternalSystemRegistry({ db,
    credentialStore: { encrypt: noWrite, decrypt: noWrite, fingerprint: noWrite },
    connectionResolver: createConnectionResolver({ facade }),
  })
  const adapterRegistry = createAdapterRegistry()
  const realFactory = createDataSourceSqlReadonlySourceAdapterFactory({ context: { api: { dataSources: facade } } })
  adapterRegistry.registerAdapter(KIND, deps => {
    events.push('adapter')
    assert.equal(deps.b2aAuthorization.purpose, B2A_PURPOSE_STOCK_PREPARATION_AUTOMATION_PREVIEW)
    return realFactory(deps)
  })
  let action = { source: { externalSystemId: row.id, kind: KIND }, target: { sheetId: 'synthetic-sheet', fieldIdMap: {} } }
  let installedFieldProperties = [], extFieldMapping = null
  if (pack) {
    const normalized = normalizeCustomerPack(FACTORY_A_REHEARSAL_PACK)
    installedFieldProperties = normalized.extensionFields.map(field => ({ fieldId: field.id, property: buildExtensionFieldProperty(field, normalized) }))
    const restored = restoreStockPreparationAutomationProfileMaterial({ material: {
      action: { ...action, extensionFieldIds: ['ext_spec'] },
      customerPacks: { [normalized.packId]: FACTORY_A_REHEARSAL_PACK },
      extFieldMappingConfig: { packId: normalized.packId, mappingId: 'synthetic-mapping', mappingVersion: 1,
        mappings: [{ sourceColumn: 'SyntheticSpec', target: 'ext_spec' }] },
    } })
    action = restored.action; extFieldMapping = restored.extFieldMapping
  }
  action = normalizeStockPreparationActionConfig(action)
  const contract = deriveAutomationReadTargetContract({ action, installedFieldProperties, extFieldMapping })
  // An explicit independently chosen physical layout catches accidental logical-id replay.
  const fieldIdMap = Object.fromEntries(contract.projection.logicalFieldIds.map((key, index) => [key, 'synthetic-physical-' + index]))
  action = { ...contract.action, target: { ...contract.action.target, fieldIdMap } }
  const claims = new Map(), claimStore = memory()
  const getClaim = claimStore.get
  claimStore.get = async key => {
    if (state.beforeClaimStore) await state.beforeClaimStore()
    return getClaim(key)
  }
  const operationClaim = createB2aOperationClaim({ db: {
    async insertOne(table, value) {
      events.push('claim'); assert.equal(table, B2A_OPERATION_CLAIM_TABLE)
      if (claims.has(value.claim_key)) throw Object.assign(new Error('Synthetic duplicate'), { code: '23505' })
      claims.set(value.claim_key, clone(value)); return [value]
    },
    async selectOne(table, where) { assert.equal(table, B2A_OPERATION_CLAIM_TABLE); return claims.get(where.claim_key) || null },
  } })
  const now = Date.now()
  const registry = createB2aRegistry({ config: { b2aTrialRegistry: { registryId: 'synthetic-registry', registryVersion: 1,
    registrations: [{ registrationId: 'synthetic-registration', registrationVersion: 1, tenantScope: actor.tenantId,
      sourceSystemType: KIND, sourceBindingRef: row.id, projectDataScope: { dataScopeRefs: ['P-001'] },
      objectScope: { sourceObjects: readPlanSourceObjects(action.source.readPlan) }, purpose,
      ownerPrincipalRef: 'synthetic-owner', authorizationRef: 'synthetic-authorization', operationRef: 'synthetic-operation',
      effectiveAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
      forbidReuse: true, sourceReadOperationLimit: 1, artifactReplayLimit: 0, consumptionState: 'unconsumed', consumedAt: null,
      b2bMigrationCondition: 'synthetic', expiryHandling: 'deny_replay', status: 'active' }],
  } } })
  const recordsApi = { async queryRecords(request) {
    events.push('records')
    assert.equal(request.sheetId, action.target.sheetId)
    assert.ok(Object.keys(request.filters).length === 0 || request.filters[fieldIdMap.projectNo] === 'P-001')
    const result = existing.filter(record => Object.entries(request.filters).every(([key, value]) => record.data[key] === value))
      .slice(request.offset, request.offset + request.limit)
    if (state.afterRecords) state.afterRecords()
    return clone(result)
  }, createRecord: noWrite, patchRecord: noWrite }
  const controller = new AbortController()
  const trackedWork = []
  const input = { action, installedFieldProperties, extFieldMapping, recordsApi, actor,
    sourceValidation: { connectionId: row.connection_id, connectionRevision: CONNECTION_REVISION, bindingRevision: BINDING_REVISION },
    projectNo: 'P-001', runId: 'synthetic-run', budget: { maxRows: 1000, maxPages: 100, maxReadCount: 100, timeoutMs: 5000 },
    signal: controller.signal, async checkpoint() { events.push('checkpoint'); if (state.beforeCheckpoint) await state.beforeCheckpoint() },
    trackPendingWork(work) { trackedWork.push(work); void work.then(() => {}, () => {}) },
  }
  const options = { externalSystems, adapterRegistry, b2aTrialRegistry: registry, b2aClaimStore: claimStore, b2aOperationClaim: operationClaim }
  const preview = createStockPreparationAutomationPreview(options)
  const before = clone(data)
  return { preview, input, options, events, state, row, data, existing, controller, claimStore, fieldIdMap, trackedWork,
    nativeReads: () => nativeReads,
    unchanged() { assert.deepEqual(data, before); assert.equal(events.includes('business-write'), false) },
  }
}
async function rejects(work, code) {
  await assert.rejects(work, error => {
    assert.ok(error instanceof StockPreparationAutomationPreviewError)
    assert.equal(error.message, error.code)
    if (code) assert.equal(error.code, code)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    assert.equal(JSON.stringify(error).includes(privateDetail), false)
    return true
  })
}
function addExistingRoot(fixture, spec) {
  const values = { projectNo: 'P-001',
    idempotencyKey: JSON.stringify({ projectNo: 'P-001', componentSourceId: 'PART-A', parentSourceId: null, path: ['PART-A'] }),
    componentSourceId: 'PART-A', parentSourceId: null, path: '["PART-A"]', depth: 0,
    componentCode: 'A-001', componentName: 'Assembly', material: 'Steel', sourceVersion: 'V1',
    rawQuantity: 2, totalQuantity: 2, active: true, notes: 'synthetic human note', ext_spec: spec,
  }
  fixture.existing.push({ id: 'synthetic-existing', sheetId: fixture.input.action.target.sheetId,
    data: Object.fromEntries(Object.entries(values).map(([key, value]) => [fixture.fieldIdMap[key], value])),
  })
}
async function assertMappedDelta(factory = createStockPreparationAutomationPreview) {
  const same = fixture({ pack: true }); addExistingRoot(same, privateDetail)
  const changed = fixture({ pack: true }); addExistingRoot(changed, 'old-synthetic-spec')
  const before = [clone(same.existing), clone(changed.existing)]
  const sameResult = await factory(same.options)(same.input)
  const changedResult = await factory(changed.options)(changed.input)
  assert.equal(sameResult.counts.skip, 1)
  assert.equal(changedResult.counts.update, 1)
  assert.equal(changedResult.counts.skip, 0)
  assert.deepEqual([same.existing, changed.existing], before)
  same.unchanged(); changed.unchanged()
}

test('actual registry/resolver/adapter/B2a/expander/planner: ready, closed DTO, no business writes', async () => {
  const f = fixture()
  const result = await f.preview(f.input)
  assert.deepEqual(result, { status: 'ready', counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false })
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.counts))
  assert.ok(f.events.indexOf('claim') < f.events.indexOf('resolve'))
  assert.ok(f.events.indexOf('resolve') < f.events.indexOf('adapter'))
  assert.ok(f.events.indexOf('schema') < f.events.indexOf('select'))
  assert.ok(f.nativeReads() > 0)
  assert.equal([...f.claimStore.values.keys()].some(key => /token/i.test(key)), false)
  f.unchanged()
})

test('genuine restored branded mapping and installed rehearsal properties reach the real planner', async () => {
  const f = fixture({ pack: true })
  const result = await f.preview(f.input)
  assert.equal(result.status, 'ready'); assert.equal(result.counts.add, 1)
  assert.equal(JSON.stringify(result).includes(privateDetail), false)
  f.unchanged()
  await assertMappedDelta()
})

test('bidirectional SQL binding retains only the existing source-read capability', async () => {
  const f = fixture({ role: 'bidirectional' })
  const result = await f.preview(f.input)
  assert.deepEqual(result, { status: 'ready', counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false })
  assert.ok(f.nativeReads() > 0)
  assert.equal([...f.claimStore.values.keys()].some(key => /token/i.test(key)), false)
  f.unchanged()
})

test('manual-purpose B2a cannot reach claim, resolver, adapter or source IO', async () => {
  const f = fixture({ purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION })
  await rejects(() => f.preview(f.input), 'AUTOMATION_PREVIEW_UNAVAILABLE')
  assert.equal(f.events.some(event => ['claim', 'resolve', 'adapter', 'schema', 'select', 'records'].includes(event)), false)
  f.unchanged()
})

test('dormant or absent B2a is refused at factory construction', () => {
  const f = fixture()
  for (const b2aTrialRegistry of [null, undefined]) assert.throws(() => createStockPreparationAutomationPreview({ ...f.options, b2aTrialRegistry }),
    error => error.code === 'AUTOMATION_PREVIEW_INPUT_INVALID')
  assert.deepEqual(f.events, [])
})

test('metadata identity, scope, kind, status and canonical pointer refuse before B2a/resolver', async () => {
  for (const patch of [{ tenant_id: 'other' }, { workspace_id: 'other' }, { kind: 'http' }, { status: 'inactive' },
    { role: 'target' }, { role: 'unknown' }, { connection_id: null }]) {
    const f = fixture(); f.state.beforeMetadata = row => Object.assign(row, patch)
    await rejects(() => f.preview(f.input), 'AUTOMATION_PREVIEW_DENIED')
    assert.equal(f.events.some(event => ['claim', 'resolve', 'adapter', 'schema', 'select'].includes(event)), false)
  }
})

test('resolved binding revision/config drift cannot construct the adapter', async () => {
  for (const patch of [{ validation_revision: CONNECTION_REVISION }, { config: { schema: 'changed' } },
    { config: { dataSourceId: 'other' } }, { status: 'inactive' }, { role: 'target' }, { role: 'unknown' }, { workspace_id: 'other' }]) {
    const f = fixture(); f.state.beforeResolve = row => Object.assign(row, patch)
    await rejects(() => f.preview(f.input))
    assert.equal(f.events.includes('adapter'), false); assert.equal(f.nativeReads(), 0)
  }
})

test('real empty-project branch stays tokenless and avoids target replay', async () => {
  const f = fixture(); f.data.DN_PDM_PathExAttrInfo.length = 0
  assert.deepEqual(await f.preview(f.input), { status: 'not_found', counts: { add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false })
  assert.equal(f.events.includes('records'), false)
})

test('foreign active target remains a refusal after the real source read', async () => {
  const f = fixture()
  f.existing.push({ id: 'foreign', data: { [f.fieldIdMap.projectNo]: 'other', [f.fieldIdMap.active]: true } })
  await rejects(() => f.preview(f.input), 'AUTOMATION_PREVIEW_UNAVAILABLE')
  assert.ok(f.nativeReads() > 0); f.unchanged()
})

test('source/schema/target replay budgets are cumulative and sticky', async () => {
  for (const budget of [{ maxRows: 1 }, { maxPages: 1 }, { maxReadCount: 1 }]) {
    const f = fixture(); Object.assign(f.input.budget, budget)
    await rejects(() => f.preview(f.input), 'AUTOMATION_PREVIEW_BUDGET_EXCEEDED')
    const reads = f.nativeReads(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.nativeReads(), reads); f.unchanged()
  }
})

test('abort before admission and abort after source return expose only fixed errors', async () => {
  const early = fixture(); early.controller.abort(privateDetail)
  await rejects(() => early.preview(early.input), 'AUTOMATION_PREVIEW_ABORTED'); assert.deepEqual(early.events, [])
  const late = fixture(); late.state.afterSelect = () => late.controller.abort(privateDetail)
  await rejects(() => late.preview(late.input), 'AUTOMATION_PREVIEW_ABORTED')
  assert.equal(late.nativeReads(), 1); assert.equal(late.events.includes('records'), false)
})

test('checkpoint revocation after read is sticky even when the expander catches the failure', async () => {
  const f = fixture(); let revoked = false
  f.state.afterSelect = () => { revoked = true }
  f.state.beforeCheckpoint = () => { if (revoked) throw new Error(privateDetail) }
  await rejects(() => f.preview(f.input), 'AUTOMATION_PREVIEW_DENIED')
  assert.equal(f.nativeReads(), 1); assert.equal(f.events.includes('records'), false)
})

test('final target-return revocation prevents publication', async () => {
  const f = fixture(); let revoked = false
  f.state.afterRecords = () => { revoked = true }
  f.state.beforeCheckpoint = () => { if (revoked) throw new Error(privateDetail) }
  await rejects(() => f.preview(f.input), 'AUTOMATION_PREVIEW_DENIED')
  assert.equal(f.events.filter(event => event === 'records').length, 1)
})

test('deadline rejects promptly; a late native result cannot schedule more reads or target replay', async () => {
  const f = fixture(); f.input.budget.timeoutMs = 25
  let release
  f.state.pendingSelect = new Promise(resolve => { release = resolve })
  await rejects(() => f.preview(f.input), 'AUTOMATION_PREVIEW_TIMEOUT')
  const before = f.nativeReads(); assert.equal(before, 1)
  assert.equal(f.trackedWork.length, 1)
  let actualSettled = false
  void f.trackedWork[0].then(() => { actualSettled = true }, () => { actualSettled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(actualSettled, false)
  release(); await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(actualSettled, true)
  assert.equal(f.nativeReads(), before); assert.equal(f.events.includes('records'), false)
})

async function assertTrackedTail(factory, stage = 'metadata', settlement = 'resolve') {
  const f = fixture()
  let enter, release, actualSettled = false
  const entered = new Promise(resolve => { enter = resolve })
  const held = new Promise((resolve, reject) => {
    release = () => settlement === 'resolve' ? resolve() : reject(new Error(privateDetail))
  })
  const hold = async () => { enter(); await held }
  f.state[stage === 'metadata' ? 'beforeMetadata' : stage === 'claim-store' ? 'beforeClaimStore' : 'beforeSelect'] = hold
  const pending = factory(f.options)(f.input)
  await entered; f.controller.abort()
  try {
    await rejects(() => pending, 'AUTOMATION_PREVIEW_ABORTED')
    assert.equal(f.trackedWork.length, 1)
    const actual = f.trackedWork[0]
    assert.ok(actual instanceof Promise)
    void actual.then(() => { actualSettled = true }, () => { actualSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(actualSettled, false)
    assert.equal(f.nativeReads(), stage === 'native' ? 1 : 0)
    assert.equal(f.events.includes('records'), false)
  } finally {
    release(); await Promise.allSettled(f.trackedWork)
  }
  assert.equal(actualSettled, true)
  assert.equal(f.nativeReads(), stage === 'native' ? 1 : 0)
  f.unchanged()
}
for (const stage of ['metadata', 'claim-store', 'native']) {
  for (const settlement of ['resolve', 'reject']) {
    test(`registered inner ${stage} ${settlement} remains pending beyond prompt abort`, async () => {
      await assertTrackedTail(createStockPreparationAutomationPreview, stage, settlement)
    })
  }
}

async function assertTrackingInput(factory, malformed = 'missing') {
  const f = fixture(); let getters = 0
  if (malformed === 'missing') delete f.input.trackPendingWork
  if (malformed === 'nonfunction') f.input.trackPendingWork = null
  if (malformed === 'getter') Object.defineProperty(f.input, 'trackPendingWork', {
    enumerable: true, get() { getters++; return () => {} },
  })
  await rejects(() => factory(f.options)(f.input), 'AUTOMATION_PREVIEW_INPUT_INVALID')
  assert.equal(getters, 0); assert.deepEqual(f.events, []); assert.equal(f.nativeReads(), 0)
}
for (const malformed of ['missing', 'nonfunction', 'getter']) {
  test(`required host tail registration refuses ${malformed} with zero IO`, async () => {
    await assertTrackingInput(createStockPreparationAutomationPreview, malformed)
  })
}

test('closed input rejects token-store/purpose/accessors without consulting token capability', async () => {
  const f = fixture(); let reads = 0
  Object.defineProperty(f.input, 'tokenStore', { enumerable: true, get() { reads++; throw new Error(privateDetail) } })
  await rejects(() => f.preview(f.input), 'AUTOMATION_PREVIEW_INPUT_INVALID')
  assert.equal(reads, 0); assert.deepEqual(f.events, [])
})

test('captured input budget and scope cannot be enlarged during an await', async () => {
  const f = fixture(); const original = f.input.checkpoint
  f.input.actor = { ...f.input.actor }
  f.input.checkpoint = async () => { f.input.budget.maxReadCount = 10000; f.input.actor.actorId = 'other'; await original() }
  f.input.budget.maxReadCount = 1
  await rejects(() => f.preview(f.input), 'AUTOMATION_PREVIEW_BUDGET_EXCEEDED')
  assert.equal(f.nativeReads(), 0)
})

test('in-memory guard mutations cannot pass behavioral proof', async () => {
  const filename = path.resolve(__dirname, '../lib/stock-preparation-automation-preview.cjs')
  const source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n')
  const checks = [
    ['inner-tail-registration', 'trackPendingWork(running)', 'void running', assertTrackedTail],
    ['required-tail-callback', "|| typeof i.trackPendingWork !== 'function'", '|| (i.trackPendingWork = () => {}, false)',
      async factory => assertTrackingInput(factory, 'nonfunction')],
    ['token-path',
      'const { previewStockPreparationForAutomation }',
      'const { dryRunStockPreparationAction: previewStockPreparationForAutomation }',
      async factory => {
        const f = fixture()
        assert.equal((await factory(f.options)(f.input)).status, 'ready')
      }],
    ['b2a-before-resolution',
      'const authorization = await guarded(() => assertB2aReadAuthorization({',
      'const authorization = await guarded(() => (async _ignored => ({ armed: true, purpose: B2A_PURPOSE_STOCK_PREPARATION_AUTOMATION_PREVIEW }))({',
      async factory => {
        const f = fixture({ purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION })
        await rejects(() => factory(f.options)(f.input))
        assert.equal(f.events.includes('resolve'), false)
      }],
    ['binding-revision', 'resolved.bindingValidationRevision !== validation.bindingRevision', 'false',
      async factory => {
        const f = fixture(); f.state.beforeResolve = row => { row.validation_revision = CONNECTION_REVISION }
        await rejects(() => factory(f.options)(f.input))
      }],
    ['checkpoint', "try { await checkpoint() } catch { stop('AUTOMATION_PREVIEW_DENIED') }", 'void checkpoint',
      async factory => {
        const f = fixture(); let revoked = false
        f.state.afterSelect = () => { revoked = true }
        f.state.beforeCheckpoint = () => { if (revoked) throw new Error(privateDetail) }
        await rejects(() => factory(f.options)(f.input), 'AUTOMATION_PREVIEW_DENIED')
      }],
    ['mapping-thread', 'extFieldMapping: material.extFieldMapping,', 'extFieldMapping: null,', assertMappedDelta],
    ['installed-material-thread', 'installedFieldProperties: material.installedFieldProperties,', 'installedFieldProperties: [],', assertMappedDelta],
  ]
  for (const [name, needle, replacement, check] of checks) {
    assert.equal(source.split(needle).length, 2, name + ': exact mutation hit')
    const altered = new Module(filename, module); altered.filename = filename; altered.paths = module.paths
    altered._compile(source.replace(needle, replacement), filename)
    await assert.rejects(() => check(altered.exports.createStockPreparationAutomationPreview), name + ': behavioral proof must kill mutation')
  }
})
