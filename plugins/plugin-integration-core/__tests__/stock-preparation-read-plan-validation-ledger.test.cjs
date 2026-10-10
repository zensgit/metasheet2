'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { randomUUID } = require('node:crypto')
const { readFileSync } = require('node:fs')
const Module = require('node:module')
const { createStockPreparationReadPlanStore, VERSION_TABLE, ACTIVATION_TABLE, AUDIT_TABLE, VALIDATION_TABLE } = require('../lib/stock-preparation-read-plan-store.cjs')
const { SOURCE_REVISION_TABLE, VALIDATION_TTL_MS } = require('../lib/stock-preparation-read-plan-validation-ledger.cjs')
const { READ_PLAN_ID } = require('../lib/stock-preparation-read-plan-config.cjs')
const clone = value => structuredClone(value)
const ACTION = 'plm.stock-preparation.pull-bom.v1'
const scope = { tenantId: 'synthetic-tenant', workspaceId: null, actor: 'synthetic-owner' }
function config() {
  return { schemaVersion: 1, actionId: ACTION, systemId: 'synthetic-system', readPlan: {
    id: READ_PLAN_ID, sourceKind: 'data-source:sql-readonly', matchField: 'project', maxReadCount: 100,
    pathExAttr: { object: 'syn.links', matchField: 'project', pathIdField: 'path' },
    pathInfo: { object: 'syn.paths', idField: 'id' },
    orderHead: { object: 'syn.orders', idField: 'id', pathIdField: 'path' },
    orderDetail: { object: 'syn.lines', orderIdField: 'orderid', componentIdField: 'part', quantityField: 'qty' },
    part: { object: 'syn.parts', idField: 'id' },
    bomHead: { object: 'syn.boms', parentPartField: 'part', bomIdField: 'id' },
    bomDetail: { object: 'syn.children', bomParentField: 'bom', componentIdField: 'part', quantityField: 'qty' },
  } }
}
async function fixture(factory = createStockPreparationReadPlanStore) {
  const revision = randomUUID()
  let state = { [VERSION_TABLE]: [], [ACTIVATION_TABLE]: [], [AUDIT_TABLE]: [], [VALIDATION_TABLE]: [],
    integration_external_systems: [{ id: 'synthetic-system', tenant_id: scope.tenantId, workspace_id: null,
      kind: 'data-source:sql-readonly', role: 'source', status: 'active', config: {},
      connection_id: 'synthetic-connection', validation_revision: randomUUID() }],
    [SOURCE_REVISION_TABLE]: [{ data_source_id: 'synthetic-connection', validation_revision: revision,
      tenant_id: scope.tenantId, workspace_id: null, owner_id: scope.actor, scope_kind: 'private',
      type: 'postgresql', is_active: true, deleted_at: null }],
  }
  const trace = []
  let clock = Date.parse('2026-10-01T12:00:00Z')
  let auditFailure = false
  const match = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value)
  function helper(data) {
    const one = (table, where, lock) => {
      assert.ok(Object.hasOwn(data, table), 'test DB must implement every production table')
      if (lock) trace.push(table)
      return clone(data[table].find(row => match(row, where)) || null)
    }
    return {
      async selectOne(table, where) { return one(table, where) },
      async selectOneForUpdate(table, where) { return one(table, where, true) },
      async selectOneForKeyShare(table, where) { return one(table, where, true) },
      async select(table, { where, orderBy, limit = 100, offset = 0 }) {
        const selected = data[table].filter(row => match(row, where))
        if (orderBy) selected.sort((a, b) => (a[orderBy[0]] > b[orderBy[0]] ? 1 : a[orderBy[0]] < b[orderBy[0]] ? -1 : 0) * (orderBy[1] === 'DESC' ? -1 : 1))
        return clone(selected.slice(offset, offset + limit))
      },
      async insertOne(table, row) {
        if (table === AUDIT_TABLE && auditFailure) throw new Error('synthetic-private-audit-failure')
        const stored = { created_at: new Date(clock), updated_at: new Date(clock),
          ...(table === VERSION_TABLE ? { validation_id: null } : {}), ...clone(row) }
        data[table].push(stored); return [clone(stored)]
      },
      async updateRow(table, set, where) {
        const row = data[table].find(candidate => match(candidate, where))
        if (!row) return []
        Object.assign(row, clone(set)); return [clone(row)]
      },
      async setTransactionIsolationLevel(level) { assert.equal(level, 'read committed'); trace.push('isolation') },
    }
  }
  const db = { ...Object.fromEntries(['selectOne', 'selectOneForUpdate', 'select', 'insertOne', 'updateRow']
    .map(key => [key, (...args) => helper(state)[key](...args)])),
    async transaction(work) { const candidate = clone(state); const result = await work(helper(candidate)); state = candidate; return result },
  }
  const store = factory({ db, now: () => clock })
  const version = await store.saveVersion({ ...scope, config: config() })
  const source = { connectionId: 'synthetic-connection', connectionRevision: revision }
  const input = { ...scope, id: version.id, source }
  const counts = { sampleCount: 2, readCount: 10, objectCount: 7 }
  const begin = () => store.beginValidation(input)
  const finish = validationId => store.finishValidation({ ...input, validationId, counts })
  const confirm = validationId => store.confirmValidation({ ...input, validationId })
  const approved = async () => {
    const receipt = await begin(); await finish(receipt.validationId); await confirm(receipt.validationId)
    await store.approve(input); return receipt
  }
  const activate = () => store.activate({ ...input, expectedGeneration: 0 })
  const runtime = () => store.getActiveForRuntime({ ...scope, actionId: ACTION, systemId: config().systemId })
  return { store, version, input, counts, source, trace, begin, finish, confirm, approved, activate, runtime,
    get state() { return state }, advance: ms => { clock += ms }, failAudit: () => { auditFailure = true } }
}
const rejects = (promise, code) => assert.rejects(promise, { code })

test('direct store cannot approve until both measured receipt and explicit human confirmation exist', async () => {
  const f = await fixture()
  await rejects(f.store.approve(f.input), 'READ_PLAN_VALIDATION_REQUIRED')
  const receipt = await f.begin()
  await rejects(f.store.approve(f.input), 'READ_PLAN_VALIDATION_REQUIRED')
  await rejects(f.confirm(receipt.validationId), 'READ_PLAN_VALIDATION_STATUS_CONFLICT')
  await f.finish(receipt.validationId)
  await rejects(f.store.approve(f.input), 'READ_PLAN_VALIDATION_REQUIRED')
  await f.confirm(receipt.validationId)
  const row = await f.store.approve(f.input)
  assert.equal(row.status, 'approved')
  const active = await f.activate()
  assert.equal(active.validationId, receipt.validationId)
  assert.equal((await f.runtime()).activation.versionId, f.version.id)
  assert.deepEqual(f.state[AUDIT_TABLE].map(row => row.action), ['save_version', 'validation_begin', 'validation_finish', 'validation_confirm', 'status_change', 'activate'])
  assert.doesNotMatch(JSON.stringify(f.state[VALIDATION_TABLE]), /syn\.parts|projectNo|password|credential|ROOT-CODE/)
})

test('gate locks isolation, mutable binding, mirror, then version and receipt', async () => {
  const f = await fixture(); f.trace.length = 0
  await f.begin()
  assert.deepEqual(f.trace.slice(0, 4), ['isolation', 'integration_external_systems', SOURCE_REVISION_TABLE, VERSION_TABLE])
})

test('one pending sample read per current connection, including a different saved version; expired crash may retry', async () => {
  const f = await fixture(); await f.begin()
  await rejects(f.begin(), 'READ_PLAN_VALIDATION_IN_PROGRESS')
  const changed = config(); changed.readPlan.part.codeField = 'code'
  const second = await f.store.saveVersion({ ...scope, config: changed })
  await rejects(f.store.beginValidation({ ...f.input, id: second.id }), 'READ_PLAN_VALIDATION_IN_PROGRESS')
  f.advance(VALIDATION_TTL_MS)
  assert.equal((await f.store.beginValidation({ ...f.input, id: second.id })).status, 'pending')
})

test('a new pending attempt supersedes a confirmed one for approval and activation', async () => {
  const f = await fixture(); const old = await f.approved(); await f.begin()
  await rejects(f.activate(), 'READ_PLAN_VALIDATION_REQUIRED')
  await rejects(f.confirm(old.validationId), 'READ_PLAN_VALIDATION_SUPERSEDED')
})

test('active receipt is frozen: pending revalidation and elapsed approval window do not silently disable it', async () => {
  const f = await fixture(); const old = await f.approved(); await f.activate(); await f.begin(); f.advance(VALIDATION_TTL_MS)
  assert.equal((await f.runtime()).activation.validationId, old.validationId)
  await rejects(f.store.activate({ ...f.input, expectedGeneration: 1 }), 'READ_PLAN_VALIDATION_REQUIRED')
})

for (const gate of ['finish', 'confirm', 'approve', 'activate']) test(`expired receipt rejects ${gate}`, async () => {
  const f = await fixture(); const receipt = await f.begin()
  if (gate !== 'finish') await f.finish(receipt.validationId)
  if (['approve', 'activate'].includes(gate)) await f.confirm(receipt.validationId)
  if (gate === 'activate') await f.store.approve(f.input)
  f.advance(VALIDATION_TTL_MS)
  const operation = gate === 'finish' ? f.finish(receipt.validationId) : gate === 'confirm' ? f.confirm(receipt.validationId)
    : gate === 'approve' ? f.store.approve(f.input) : f.activate()
  await rejects(operation, 'READ_PLAN_VALIDATION_EXPIRED')
})

for (const mutation of ['source-revision', 'binding-revision', 'owner', 'tenant', 'workspace', 'legacy', 'inactive', 'type', 'rebind']) {
  test(`source change ${mutation} during read cannot produce passing proof or reuse old active proof`, async () => {
    const f = await fixture(); await f.approved(); await f.activate(); const attempt = await f.begin()
    const revision = f.state[SOURCE_REVISION_TABLE][0]
    if (mutation === 'source-revision') revision.validation_revision = randomUUID()
    if (mutation === 'binding-revision') f.state.integration_external_systems[0].validation_revision = randomUUID()
    if (mutation === 'owner') revision.owner_id = 'new-owner'
    if (mutation === 'tenant') revision.tenant_id = 'foreign-tenant'
    if (mutation === 'workspace') revision.workspace_id = 'another-workspace'
    if (mutation === 'legacy') revision.scope_kind = 'legacy_private'
    if (mutation === 'inactive') revision.is_active = false
    if (mutation === 'type') revision.type = 'mysql'
    if (mutation === 'rebind') f.state.integration_external_systems[0].connection_id = 'new-connection'
    await assert.rejects(f.finish(attempt.validationId))
    await assert.rejects(f.runtime())
    assert.equal(f.state[VALIDATION_TABLE].at(-1).status, 'pending')
  })
}

test('source owner transfer permits new current owner to revalidate old immutable content, not use creator privilege', async () => {
  const f = await fixture(); await f.approved()
  const revision = f.state[SOURCE_REVISION_TABLE][0]
  revision.owner_id = 'new-owner'; revision.validation_revision = randomUUID()
  await assert.rejects(f.activate())
  const input = { ...f.input, actor: 'new-owner', source: { ...f.source, connectionRevision: revision.validation_revision } }
  const receipt = await f.store.beginValidation(input)
  await f.store.finishValidation({ ...input, validationId: receipt.validationId, counts: f.counts })
  await f.store.confirmValidation({ ...input, validationId: receipt.validationId })
  assert.equal((await f.store.activate({ ...input, expectedGeneration: 0 })).updatedBy, 'new-owner')
  assert.equal((await f.runtime()).version.createdBy, scope.actor)
})

test('cross-tenant and different confirmer cannot consume a receipt', async () => {
  const f = await fixture(); const receipt = await f.begin(); await f.finish(receipt.validationId)
  await rejects(f.store.confirmValidation({ ...f.input, tenantId: 'foreign', validationId: receipt.validationId }), 'READ_PLAN_NOT_FOUND')
  await assert.rejects(f.store.confirmValidation({ ...f.input, actor: 'other-admin', validationId: receipt.validationId }))
  assert.equal(f.state[VALIDATION_TABLE][0].status, 'passed')
})

for (const operation of ['begin', 'finish', 'confirm', 'approve', 'activate']) test(`audit failure rolls back ${operation} state and evidence`, async () => {
  const f = await fixture(); let receipt
  if (operation !== 'begin') receipt = await f.begin()
  if (['confirm', 'approve', 'activate'].includes(operation)) await f.finish(receipt.validationId)
  if (['approve', 'activate'].includes(operation)) await f.confirm(receipt.validationId)
  if (operation === 'activate') await f.store.approve(f.input)
  f.failAudit(); const before = clone(f.state)
  const result = operation === 'begin' ? f.begin() : operation === 'finish' ? f.finish(receipt.validationId)
    : operation === 'confirm' ? f.confirm(receipt.validationId) : operation === 'approve' ? f.store.approve(f.input) : f.activate()
  await assert.rejects(result, /synthetic-private-audit-failure/)
  assert.deepEqual(f.state, before)
})

test('failed attempt cannot be confirmed, and counts reject missing/zero/fractional or extra fields', async () => {
  const f = await fixture(); const receipt = await f.begin()
  for (const counts of [{ ...f.counts, sampleCount: 0 }, { ...f.counts, readCount: 1.5 }, { ...f.counts, projectNo: 'SYN' }, {}]) {
    await rejects(f.store.finishValidation({ ...f.input, validationId: receipt.validationId, counts }), 'READ_PLAN_VALIDATION_COUNTS_INVALID')
  }
  await f.store.failValidation({ ...f.input, validationId: receipt.validationId })
  await rejects(f.confirm(receipt.validationId), 'READ_PLAN_VALIDATION_STATUS_CONFLICT')
  await rejects(f.store.approve(f.input), 'READ_PLAN_VALIDATION_REQUIRED')
})

// In-memory, one-edit mutants. No production file or global require cache is
// replaced. The real store consumes the mutated real ledger through its actual
// dependency edge; each witness first rejects under the unmodified chain.
function mutantFactory(needle, replacement, mutateStore = false) {
  const ledgerPath = require.resolve('../lib/stock-preparation-read-plan-validation-ledger.cjs')
  const storePath = require.resolve('../lib/stock-preparation-read-plan-store.cjs')
  const target = mutateStore ? storePath : ledgerPath
  const bytes = readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
  assert.equal(bytes.split(needle).length, 2, 'exact unique mutation target')
  function compile(filename, source, dependency) {
    const compiled = new Module(filename, module)
    compiled.filename = filename
    compiled.paths = Module._nodeModulePaths(require('node:path').dirname(filename))
    const original = compiled.require.bind(compiled)
    compiled.require = id => dependency && id === './stock-preparation-read-plan-validation-ledger.cjs'
      ? dependency : original(id)
    compiled._compile(source, filename)
    return compiled.exports
  }
  if (mutateStore) return compile(storePath, bytes.replace(needle, replacement)).createStockPreparationReadPlanStore
  const ledger = compile(ledgerPath, bytes.replace(needle, replacement))
  return compile(storePath, readFileSync(storePath, 'utf8'), ledger).createStockPreparationReadPlanStore
}

for (const mutation of [
  { label: 'human confirmation', needle: "if (receipt.status !== 'confirmed') fail(409, 'READ_PLAN_VALIDATION_REQUIRED')",
    replacement: 'void receipt', code: 'READ_PLAN_VALIDATION_REQUIRED',
    async prepare(f) { const receipt = await f.begin(); await f.finish(receipt.validationId) } },
  { label: 'receipt expiry', needle: "if (requireUnexpired && clock() >= timestamp(receipt.expires_at)) fail(409, 'READ_PLAN_VALIDATION_EXPIRED')",
    replacement: 'void requireUnexpired', code: 'READ_PLAN_VALIDATION_EXPIRED',
    async prepare(f) { const receipt = await f.begin(); await f.finish(receipt.validationId); await f.confirm(receipt.validationId); f.advance(VALIDATION_TTL_MS) } },
  { label: 'binding revision', needle: '|| receipt.binding_revision !== source.bindingRevision',
    replacement: '', code: 'READ_PLAN_VALIDATION_SOURCE_CHANGED',
    async prepare(f) { const receipt = await f.begin(); await f.finish(receipt.validationId); await f.confirm(receipt.validationId); f.state.integration_external_systems[0].validation_revision = randomUUID() } },
  { label: 'connection revision', needle: '|| receipt.connection_revision !== source.connectionRevision',
    replacement: '', code: 'READ_PLAN_VALIDATION_SOURCE_CHANGED',
    async prepare(f) { const receipt = await f.begin(); await f.finish(receipt.validationId); await f.confirm(receipt.validationId); f.state[SOURCE_REVISION_TABLE][0].validation_revision = randomUUID() } },
  { label: 'current source owner', needle: 'revision.owner_id !== actor || ',
    replacement: '', code: 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE',
    async prepare(f) { const receipt = await f.begin(); await f.finish(receipt.validationId); await f.confirm(receipt.validationId); f.state[SOURCE_REVISION_TABLE][0].owner_id = 'new-owner' } },
]) test(`mutation: ${mutation.label} guard is independently necessary on the real store path`, async () => {
  const real = await fixture(); await mutation.prepare(real)
  await rejects(real.store.approve(real.input), mutation.code)
  const mutant = await fixture(mutantFactory(mutation.needle, mutation.replacement)); await mutation.prepare(mutant)
  assert.equal((await mutant.store.approve(mutant.input)).status, 'approved')
})

test('mutation: removing approval wiring approves an unvalidated draft through the actual store', async () => {
  const real = await fixture()
  await rejects(real.store.approve(real.input), 'READ_PLAN_VALIDATION_REQUIRED')
  const mutant = await fixture(mutantFactory('await validation.requireConfirmed(trx, scope, version, source, by)\n        if (version.status !== from)', 'void source\n        if (version.status !== from)', true))
  assert.equal((await mutant.store.approve(mutant.input)).status, 'approved')
})

test('mutation: removing activation wiring activates a superseding pending receipt', async () => {
  const real = await fixture(); await real.approved(); await real.begin()
  await rejects(real.activate(), 'READ_PLAN_VALIDATION_REQUIRED')
  const mutant = await fixture(mutantFactory('const receipt = await validation.requireConfirmed(trx, scope, version, source, by)',
    'const receipt = { id: version.validationId }', true))
  await mutant.approved(); await mutant.begin()
  assert.equal((await mutant.activate()).status, 'active')
})
