'use strict'

const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFileSync } = require('node:fs')
const Module = require('node:module')
const { test } = require('node:test')
const { HttpRouteError, __internals } = require('../lib/http-routes.cjs')
const { createExternalSystemRegistry } = require('../lib/external-systems.cjs')
const { VERSION_TABLE, ACTIVATION_TABLE, AUDIT_TABLE, VALIDATION_TABLE, createStockPreparationReadPlanStore } = require('../lib/stock-preparation-read-plan-store.cjs')
const { SOURCE_REVISION_TABLE } = require('../lib/stock-preparation-read-plan-validation-ledger.cjs')
const { READ_PLAN_MANAGEMENT_ROUTES, createStockPreparationReadPlanManagement,
  createStockPreparationReadPlanManagementHandlers } = require('../lib/stock-preparation-read-plan-management.cjs')

const ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const SCOPE = { tenantId: 'synthetic-tenant', workspaceId: null }
const STATUS_FIXTURE_COUNTS = Object.freeze({ sampleCount: 2, readCount: 10, objectCount: 7 })
const clone = (value) => structuredClone(value)
function config(systemId = 'synthetic-source') {
  const role = (object, fields) => ({ object, ...Object.fromEntries(fields.map((field) => [field, field])) })
  return { schemaVersion: 1, actionId: ACTION_ID, systemId, readPlan: {
    id: 'plm.stock-preparation.bom-read.user-draft.v1', sourceKind: 'data-source:sql-readonly',
    matchField: 'matchField', maxReadCount: 200,
    pathExAttr: role('SYN_PathLink', ['matchField', 'pathIdField']),
    pathInfo: role('SYN_Path', ['idField']),
    orderHead: role('SYN_Order', ['idField', 'pathIdField']),
    orderDetail: role('SYN_OrderLine', ['orderIdField', 'componentIdField', 'quantityField']),
    part: role('SYN_Part', ['idField']),
    bomHead: role('SYN_Bom', ['parentPartField', 'bomIdField']),
    bomDetail: role('SYN_BomLine', ['bomParentField', 'componentIdField', 'quantityField']),
  } }
}
function bindSource(id = 'synthetic-source', connectionId = 'synthetic-connection', type = 'sqlserver', owner = 'synthetic-owner') {
  const bindingRevision = randomUUID()
  const connectionRevision = randomUUID()
  return {
    system: { id, tenant_id: SCOPE.tenantId, workspace_id: null, connection_id: connectionId,
      kind: 'data-source:sql-readonly', role: 'source', status: 'active', name: 'Synthetic source', config: {},
      validation_revision: bindingRevision },
    revision: { data_source_id: connectionId, validation_revision: connectionRevision,
      tenant_id: SCOPE.tenantId, workspace_id: null, owner_id: owner, scope_kind: 'private',
      type, is_active: true, deleted_at: null },
    registration: { id: connectionId, owner, tenantId: SCOPE.tenantId, scopeKind: 'private', type,
      validationRevision: connectionRevision },
  }
}
function memoryDb(bound = bindSource()) {
  let state = { [VERSION_TABLE]: [], [ACTIVATION_TABLE]: [], [AUDIT_TABLE]: [], [VALIDATION_TABLE]: [],
    integration_external_systems: [clone(bound.system)], [SOURCE_REVISION_TABLE]: [clone(bound.revision)] }
  const trace = []
  const locks = []
  let auditFailure = false
  let beforeTransaction = null
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value)
  function helper(data) {
    const one = (kind, table, where) => {
      trace.push(`${kind}:${table}`)
      if (kind === 'lock') locks.push({ table, where: clone(where) })
      return clone(data[table].find((row) => matches(row, where)) || null)
    }
    return {
      async selectOne(table, where) { return one('get', table, where) },
      async selectOneForUpdate(table, where) { return one('lock', table, where) },
      async selectOneForKeyShare(table, where) { return one('keyShare', table, where) },
      async select(table, { where = {}, orderBy, limit = 1000, offset = 0 } = {}) {
        trace.push(`list:${table}`)
        const found = data[table].filter((row) => matches(row, where))
        if (orderBy) {
          const [key, direction] = orderBy
          found.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (direction === 'DESC' ? -1 : 1))
        }
        return clone(found.slice(offset, offset + limit))
      },
      async insertOne(table, row) {
        trace.push(`insert:${table}`)
        if (table === AUDIT_TABLE && auditFailure) throw new Error('synthetic-private-driver-message')
        const saved = { ...clone(row), created_at: 'synthetic-time', updated_at: 'synthetic-time' }
        data[table].push(saved)
        return [clone(saved)]
      },
      async updateRow(table, set, where) {
        trace.push(`update:${table}`)
        const row = data[table].find((item) => matches(item, where))
        if (!row) return []
        Object.assign(row, clone(set))
        return [clone(row)]
      },
      async setTransactionIsolationLevel(level) { assert.equal(level, 'read committed') },
      async deleteRows() { assert.fail('management must never delete') },
      async countRows() { return 0 },
    }
  }
  return {
    ...Object.fromEntries(['select', 'selectOne', 'selectOneForUpdate', 'selectOneForKeyShare', 'insertOne', 'updateRow', 'deleteRows', 'countRows']
      .map((method) => [method, (...args) => helper(state)[method](...args)])),
    get state() { return state }, trace, locks,
    set auditFailure(value) { auditFailure = value },
    set beforeTransaction(value) { beforeTransaction = value },
    async transaction(callback) {
      if (beforeTransaction) { const hook = beforeTransaction; beforeTransaction = null; await hook(state) }
      const working = clone(state)
      const result = await callback(helper(working))
      state = working
      return result
    },
  }
}
function harness(factory = createStockPreparationReadPlanStore) {
  const bound = bindSource()
  const db = memoryDb(bound)
  let sequence = 0
  const store = factory({ db, idGenerator: () => `synthetic-version-${++sequence}` })
  const connections = new Map([[bound.registration.id, bound.registration]])
  const sourceReads = []
  const registrationCalls = []
  const externalSystemRegistry = createExternalSystemRegistry({ db, credentialStore: {
    encrypt() { assert.fail('no credentials') }, fingerprint() { assert.fail('fixture has no credentials') },
    decrypt() { assert.fail('no credential reload') },
  } })
  const connectionRegistration = {
    async resolveConnectionRegistration(id, options) {
      registrationCalls.push({ id, options: clone(options) })
      const connection = connections.get(id)
      if (!connection || connection.owner !== options.principal) throw new Error('synthetic-private-connection-detail')
      return clone(connection)
    },
    test() { assert.fail('management must not open a physical connection') },
    getSchema() { assert.fail('management must not inspect source schema') },
    select() { assert.fail('management must not execute a read') },
  }
  const management = createStockPreparationReadPlanManagement({ store, externalSystemRegistry, connectionRegistration })
  const helpers = {
    requireAccess: __internals.requireAccess,
    resolveVerifiedClaimTenantId: __internals.resolveVerifiedClaimTenantId,
    requestPrincipal: (req) => req.user && (req.user.id || req.user.email),
    requestBody: (req) => req.body || {}, requestQuery: (req) => req.query || {}, requestParams: (req) => req.params || {},
    sendOk: (res, data, status = 200) => res.status(status).json({ ok: true, data }), HttpRouteError,
  }
  const handlers = createStockPreparationReadPlanManagementHandlers({ management, helpers, readSample: async () => {
    sourceReads.push('source-read')
    throw new Error('metadata operation performed source IO')
  } })
  async function call(operation, overrides = {}) {
    const req = { user: { id: 'synthetic-owner', tenantId: SCOPE.tenantId, permissions: ['integration:admin'] },
      authenticatedTenantId: SCOPE.tenantId, headers: {}, params: {},
      body: operation === 'List' ? {} : { managementScope: 'tenant' },
      query: operation === 'List' ? { managementScope: 'tenant', systemId: 'synthetic-source' } : {}, ...overrides }
    const response = { statusCode: null, payload: null,
      status(value) { this.statusCode = value; return this }, json(value) { this.payload = value; return value } }
    await handlers[`stockPreparationReadPlanConfigs${operation}`](req, response)
    return response.payload.data
  }
  const save = (systemId = 'synthetic-source') => call('Save', { body: { managementScope: 'tenant', config: config(systemId) } })
  const mutate = (operation, id, systemId = 'synthetic-source', extra = {}, overrides = {}) => call(operation, {
    params: id ? { id } : {}, body: { managementScope: 'tenant', systemId, ...extra }, ...overrides,
  })
  function installBound(id, connectionId, type = 'sqlserver') {
    const added = bindSource(id, connectionId, type)
    db.state.integration_external_systems.push(added.system)
    db.state[SOURCE_REVISION_TABLE].push(added.revision)
    connections.set(connectionId, added.registration)
    return added
  }
  return { db, store, management, handlers, helpers, call, save, mutate, connections, registrationCalls, sourceReads, installBound }
}
// Synthetic status fixture, NOT source-validation proof. The PostgreSQL host suite
// owns the measured gate. This only plants a confirmed receipt for the current revision.
async function seedConfirmedStatusFixture(planStore, db, { id, connectionId, actor = 'synthetic-owner' }) {
  const revision = db.state[SOURCE_REVISION_TABLE].find((row) => row.data_source_id === connectionId)
  assert.ok(revision, 'synthetic status fixture requires the current source revision')
  const source = { connectionId, connectionRevision: revision.validation_revision }
  const input = { ...SCOPE, actor, id, source }
  const begun = await planStore.beginValidation(input)
  await planStore.finishValidation({ ...input, validationId: begun.validationId, counts: STATUS_FIXTURE_COUNTS })
  await planStore.confirmValidation({ ...input, validationId: begun.validationId })
  return begun
}
async function rejectsCode(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code)
    if (status) assert.equal(error.status, status)
    assert.doesNotMatch(error.message, /synthetic-private|SYN_Part|synthetic-connection/)
    return true
  })
}
function noVersionAccess(trace) {
  assert.equal(trace.some((event) => [VERSION_TABLE, ACTIVATION_TABLE, AUDIT_TABLE, VALIDATION_TABLE, SOURCE_REVISION_TABLE]
    .some((table) => event.includes(table))), false)
}

test('closed route definitions reach real handler + store save, approve, activate, retire and disable', async () => {
  const h = harness()
  assert.equal(READ_PLAN_MANAGEMENT_ROUTES.length, 8)
  assert.ok(READ_PLAN_MANAGEMENT_ROUTES.some(([, path]) => path.endsWith('/:id/validate')))
  assert.ok(READ_PLAN_MANAGEMENT_ROUTES.some(([, path]) => path.endsWith('/:id/confirm-sample')))
  for (const [method, path, handler] of READ_PLAN_MANAGEMENT_ROUTES) {
    assert.ok(['GET', 'POST'].includes(method)); assert.match(path, /^\/api\/integration\/stock-preparation\/read-plan-configs/)
    assert.equal(typeof h.handlers[handler], 'function')
  }
  assert.deepEqual(await h.call('List'), { versions: [], activation: null })
  const draft = await h.save()
  assert.equal(draft.workspaceId, null); assert.equal(draft.status, 'draft')
  assert.equal(draft.createdBy, 'synthetic-owner')
  assert.equal((await h.save()).id, draft.id)
  assert.equal((await h.call('List')).versions[0].validation, null)
  await rejectsCode(h.mutate('Activate', draft.id, undefined, { expectedGeneration: 0 }), 'READ_PLAN_NOT_APPROVED')
  const proof = await seedConfirmedStatusFixture(h.store, h.db, { id: draft.id, connectionId: 'synthetic-connection' })
  await h.mutate('Approve', draft.id)
  const active = await h.mutate('Activate', draft.id, undefined, { expectedGeneration: 0 })
  assert.equal(active.generation, 1)
  assert.equal(active.validationId, proof.validationId)
  const listed = await h.call('List')
  assert.equal(listed.versions[0].id, draft.id); assert.equal(listed.activation.versionId, draft.id)
  assert.equal(listed.versions[0].validation.status, 'confirmed')
  assert.equal(listed.versions[0].validation.validationId, proof.validationId)
  assert.deepEqual(listed.versions[0].validation.counts, STATUS_FIXTURE_COUNTS)
  await h.mutate('Retire', draft.id)
  const disabled = await h.mutate('Deactivate', null, undefined, { expectedGeneration: 1 })
  assert.equal(disabled.status, 'disabled'); assert.equal(disabled.generation, 2)
  assert.deepEqual(h.db.state[AUDIT_TABLE].map((row) => row.action), [
    'save_version', 'reuse_version', 'validation_begin', 'validation_finish', 'validation_confirm',
    'status_change', 'activate', 'status_change', 'deactivate',
  ])
  assert.equal(h.sourceReads.length, 0)
  assert.ok(h.registrationCalls.every(({ options }) => options.principal === 'synthetic-owner'
    && options.runAs === 'user' && options.workspaceId === null && options.tenantId === SCOPE.tenantId))
})

test('each independent identity gate denies before metadata and ledger access', async () => {
  const cases = [
    [{ user: null }, 'UNAUTHENTICATED'],
    [{ user: { id: 'synthetic-owner', tenantId: SCOPE.tenantId, permissions: ['integration:write'] } }, 'FORBIDDEN'],
    [{ authenticatedTenantId: undefined, headers: { 'x-tenant-id': SCOPE.tenantId } }, 'TENANT_CLAIM_REQUIRED'],
    [{ user: { id: 'synthetic-owner', permissions: ['role:admin'] }, authenticatedTenantId: undefined }, 'TENANT_CLAIM_REQUIRED'],
    [{ user: { id: 'synthetic-owner', tenantId: 'other-tenant', permissions: ['integration:admin'] } }, 'TENANT_MISMATCH'],
    [{ user: { tenantId: SCOPE.tenantId, permissions: ['integration:admin'] } }, 'READ_PLAN_IDENTITY_REQUIRED'],
  ]
  for (const [overrides, code] of cases) {
    const h = harness()
    await rejectsCode(h.call('Save', { body: { managementScope: 'tenant', config: config() }, ...overrides }), code)
    assert.deepEqual(h.db.trace, []); assert.equal(h.registrationCalls.length, 0)
  }
})

test('strict shape rejects steering, workspace, forged authority and executable extensions', async () => {
  const changes = [
    { body: { config: config() } },
    { body: { managementScope: 'workspace', config: config() } },
    { body: { managementScope: 'tenant', config: config(), actor: 'other-owner' } },
    { body: { managementScope: 'tenant', config: config(), workspaceId: 'other-workspace' } },
    { body: { managementScope: 'tenant', config: config(), workspaceId: null } },
    { query: { workspaceId: 'other-workspace' } },
    { query: { tenantId: 'other-tenant' } },
    { params: { workspaceId: 'other-workspace' } },
    { headers: { 'x-workspace-id': 'other-workspace' } },
    { body: [] },
    { body: { managementScope: 'tenant', config: { ...config(), principal: 'other-owner' } } },
  ]
  for (const changed of changes) {
    const h = harness()
    await assert.rejects(h.call('Save', { body: { managementScope: 'tenant', config: config() }, ...changed }), (error) => {
      assert.ok([400, 403].includes(error.status)); assert.doesNotMatch(error.message, /other-workspace|other-owner/); return true
    })
    assert.deepEqual(h.db.trace, []); assert.equal(h.registrationCalls.length, 0)
  }
  const h = harness()
  await rejectsCode(h.call('List', { query: { managementScope: 'tenant', systemId: ['synthetic-source'] } }), 'READ_PLAN_HANDLE_INVALID')
  await rejectsCode(h.call('List', { query: { managementScope: 'tenant', systemId: 'synthetic-source', status: 'approved' } }), 'READ_PLAN_REQUEST_INVALID')
})

test('current-owner source guards are individually isolated and deny before config access', async () => {
  const changes = [
    (h) => { h.connections.get('synthetic-connection').owner = 'other-owner' },
    (h) => { h.connections.get('synthetic-connection').tenantId = null; h.connections.get('synthetic-connection').scopeKind = 'legacy_private' },
    (h) => { h.connections.get('synthetic-connection').tenantId = 'other-tenant' },
    (h) => { h.connections.get('synthetic-connection').scopeKind = 'legacy_private' },
    (h) => { h.connections.get('synthetic-connection').scopeKind = 'workspace' },
    (h) => { h.connections.get('synthetic-connection').id = 'other-connection' },
    (h) => { h.connections.get('synthetic-connection').type = 'http' },
    (h) => { h.db.state.integration_external_systems[0].connection_id = null },
    (h) => { h.db.state.integration_external_systems[0].workspace_id = 'other-workspace' },
    (h) => { h.db.state.integration_external_systems[0].tenant_id = 'other-tenant' },
    (h) => { h.db.state.integration_external_systems[0].kind = 'erp:k3-wise-webapi' },
    (h) => { h.db.state.integration_external_systems[0].role = 'target' },
    (h) => { h.db.state.integration_external_systems[0].config.dataSourceId = 'other-connection' },
  ]
  for (const change of changes) {
    const h = harness()
    await h.save()
    h.db.trace.length = 0
    change(h)
    await rejectsCode(h.call('List'), 'READ_PLAN_SOURCE_UNAVAILABLE', 403)
    noVersionAccess(h.db.trace)
    assert.equal(h.db.state[AUDIT_TABLE].length, 1)
  }
})

test('transfer/rebinding revokes former owner for every management entry and never trusts creator stamp', async () => {
  const h = harness()
  const draft = await h.save()
  await seedConfirmedStatusFixture(h.store, h.db, { id: draft.id, connectionId: 'synthetic-connection' })
  await h.mutate('Approve', draft.id)
  await h.mutate('Activate', draft.id, undefined, { expectedGeneration: 0 })
  const revision = h.db.state[SOURCE_REVISION_TABLE][0]
  const nextRevision = randomUUID()
  revision.validation_revision = nextRevision
  h.connections.get('synthetic-connection').validationRevision = nextRevision
  await rejectsCode(h.mutate('Activate', draft.id, undefined, { expectedGeneration: 1 }), 'READ_PLAN_VALIDATION_SOURCE_CHANGED', 409)
  revision.owner_id = 'new-owner'
  h.connections.get('synthetic-connection').owner = 'new-owner'
  h.db.state.integration_external_systems[0].config.dataSourceOwnerId = 'synthetic-owner'
  for (const operation of ['Save', 'List', 'Approve', 'Retire', 'Activate', 'Deactivate']) {
    const before = JSON.stringify(h.db.state)
    h.db.trace.length = 0
    const promise = operation === 'Save' ? h.save() : operation === 'List' ? h.call('List')
      : h.mutate(operation, operation === 'Deactivate' ? null : draft.id, undefined, { ...(operation === 'Activate' || operation === 'Deactivate' ? { expectedGeneration: 1 } : {}) })
    await rejectsCode(promise, 'READ_PLAN_SOURCE_UNAVAILABLE', 403)
    noVersionAccess(h.db.trace); assert.equal(JSON.stringify(h.db.state), before)
  }
  const newOwner = { user: { id: 'new-owner', tenantId: SCOPE.tenantId, permissions: ['integration:admin'] } }
  assert.equal((await h.call('List', newOwner)).versions[0].createdBy, 'synthetic-owner')
  // The new current owner revalidates the same immutable content. createdBy stays the original actor.
  const revalidated = await seedConfirmedStatusFixture(h.store, h.db, {
    id: draft.id, connectionId: 'synthetic-connection', actor: 'new-owner',
  })
  const listed = await h.call('List', newOwner)
  assert.equal(listed.versions[0].createdBy, 'synthetic-owner')
  assert.equal(listed.versions[0].validation.validationId, revalidated.validationId)
  assert.equal(listed.versions[0].validation.status, 'confirmed')
  assert.equal(h.db.state[VALIDATION_TABLE].at(-1).actor, 'new-owner')
  await h.mutate('Deactivate', null, undefined, { expectedGeneration: 1 }, newOwner)
  assert.equal(h.db.state[AUDIT_TABLE].at(-1).actor, 'new-owner')
  h.db.state.integration_external_systems[0].connection_id = 'rebound-connection'
  h.connections.set('rebound-connection', { id: 'rebound-connection', owner: 'third-owner', tenantId: SCOPE.tenantId, scopeKind: 'private', type: 'sqlserver', validationRevision: randomUUID() })
  await rejectsCode(h.call('List', newOwner), 'READ_PLAN_SOURCE_UNAVAILABLE')
})

test('family-scoped list, cross-family IDs, and old/new activation owner authorization', async () => {
  const h = harness()
  h.installBound('second-source', 'second-connection', 'postgres')
  const first = await h.save()
  const second = await h.save('second-source')
  await seedConfirmedStatusFixture(h.store, h.db, { id: first.id, connectionId: 'synthetic-connection' })
  await h.mutate('Approve', first.id)
  await seedConfirmedStatusFixture(h.store, h.db, { id: second.id, connectionId: 'second-connection' })
  await h.mutate('Approve', second.id, 'second-source')
  await h.mutate('Activate', first.id, undefined, { expectedGeneration: 0 })
  assert.deepEqual((await h.call('List')).versions.map((row) => row.id), [first.id])
  await rejectsCode(h.mutate('Retire', second.id), 'READ_PLAN_NOT_FOUND', 404)
  await rejectsCode(h.mutate('Activate', second.id, undefined, { expectedGeneration: 1 }), 'READ_PLAN_NOT_FOUND', 404)
  await rejectsCode(h.mutate('Deactivate', null, 'second-source', { expectedGeneration: 1 }), 'READ_PLAN_ACTIVATION_SOURCE_MISMATCH')
  h.connections.get('synthetic-connection').owner = 'old-system-owner'
  const before = JSON.stringify(h.db.state)
  await rejectsCode(h.mutate('Activate', second.id, 'second-source', { expectedGeneration: 1 }), 'READ_PLAN_SOURCE_UNAVAILABLE')
  await rejectsCode(h.call('List', { query: { managementScope: 'tenant', systemId: 'second-source' } }), 'READ_PLAN_SOURCE_UNAVAILABLE')
  assert.equal(JSON.stringify(h.db.state), before)
  h.connections.get('synthetic-connection').owner = 'synthetic-owner'
  const switched = await h.mutate('Activate', second.id, 'second-source', { expectedGeneration: 1 })
  assert.equal(switched.systemId, 'second-source'); assert.equal(switched.generation, 2)
  assert.equal((await h.call('List')).activation.systemId, 'second-source')
})

test('inactive current source allows list, retirement and disabling but denies new trust', async () => {
  const h = harness()
  const approved = await h.save()
  await seedConfirmedStatusFixture(h.store, h.db, { id: approved.id, connectionId: 'synthetic-connection' })
  await h.mutate('Approve', approved.id)
  await h.mutate('Activate', approved.id, undefined, { expectedGeneration: 0 })
  const changed = config(); changed.readPlan.part.nameField = 'nameField'
  const draft = await h.call('Save', { body: { managementScope: 'tenant', config: changed } })
  h.db.state.integration_external_systems[0].status = 'inactive'
  await rejectsCode(h.save(), 'READ_PLAN_SOURCE_UNAVAILABLE')
  await rejectsCode(h.mutate('Approve', draft.id), 'READ_PLAN_SOURCE_UNAVAILABLE')
  await rejectsCode(h.mutate('Activate', approved.id, undefined, { expectedGeneration: 1 }), 'READ_PLAN_SOURCE_UNAVAILABLE')
  assert.equal((await h.call('List')).versions.length, 2)
  await h.mutate('Retire', approved.id)
  assert.equal((await h.mutate('Deactivate', null, undefined, { expectedGeneration: 1 })).status, 'disabled')
})

async function metadataRace(operation, change, factory) {
  const h = harness(factory)
  const first = await h.save()
  await seedConfirmedStatusFixture(h.store, h.db, { id: first.id, connectionId: 'synthetic-connection' })
  await h.mutate('Approve', first.id)
  await h.mutate('Activate', first.id, undefined, { expectedGeneration: 0 })
  let next
  if (operation === 'Switch') {
    h.installBound('alpha-source', 'zeta-connection', 'postgres')
    next = await h.save('alpha-source')
    await seedConfirmedStatusFixture(h.store, h.db, { id: next.id, connectionId: 'zeta-connection' })
    await h.mutate('Approve', next.id, 'alpha-source')
  }
  const before = clone(Object.fromEntries([VERSION_TABLE, ACTIVATION_TABLE, AUDIT_TABLE, VALIDATION_TABLE]
    .map(table => [table, h.db.state[table]])))
  h.db.beforeTransaction = state => {
    // This hook runs after the real management owner prechecks and the store's
    // unlocked hints, immediately before the actual mutation transaction.
    if (change === 'owner') state[SOURCE_REVISION_TABLE][0].owner_id = 'new-owner'
    else {
      const rebound = bindSource('unused', 'rebound-connection', 'sqlserver', 'new-owner')
      state[SOURCE_REVISION_TABLE].push(rebound.revision)
      state.integration_external_systems[0].connection_id = rebound.registration.id
      state.integration_external_systems[0].validation_revision = randomUUID()
      h.connections.set(rebound.registration.id, rebound.registration)
    }
  }
  const changed = config(); changed.readPlan.part.nameField = 'newName'
  const run = () => operation === 'SaveNew'
    ? h.call('Save', { body: { managementScope: 'tenant', config: changed } })
    : operation === 'SaveReuse' ? h.save()
      : operation === 'Switch' ? h.mutate('Activate', next.id, 'alpha-source', { expectedGeneration: 1 })
        : h.mutate(operation, operation === 'Deactivate' ? null : first.id, undefined,
          operation === 'Deactivate' ? { expectedGeneration: 1 } : {})
  return { h, run, assertUnchanged() {
    for (const [table, rows] of Object.entries(before)) assert.deepEqual(h.db.state[table], rows, table)
    assert.deepEqual(h.sourceReads, [])
  } }
}

for (const operation of ['SaveNew', 'SaveReuse', 'Retire', 'Deactivate', 'Switch']) {
  for (const change of ['owner', 'rebind']) test(`transaction owner fence rejects ${operation} after ${change} passes request precheck`, async () => {
    const race = await metadataRace(operation, change)
    await rejectsCode(race.run(), 'READ_PLAN_SOURCE_INELIGIBLE', 409)
    race.assertUnchanged()
  })
}

function withoutStoreGuard(needle) {
  const filename = require.resolve('../lib/stock-preparation-read-plan-store.cjs')
  const source = readFileSync(filename, 'utf8').replace(/\r\n/g, '\n')
  assert.equal(source.split(needle).length, 2, 'one exact guard mutation')
  const compiled = new Module(filename, module)
  compiled.filename = filename
  compiled.paths = Module._nodeModulePaths(require('node:path').dirname(filename))
  compiled._compile(source.replace(needle, ''), filename)
  return compiled.exports.createStockPreparationReadPlanStore
}

for (const [operation, needle] of [
  ['SaveNew', "await validation.lockSources(trx, scope, [{ systemId: normalized.systemId, mode: 'draft' }], by)"],
  ['SaveReuse', "await validation.lockSources(trx, scope, [{ systemId: normalized.systemId, mode: 'draft' }], by)"],
  ['Retire', "await validation.lockSources(trx, scope, [{ systemId: hinted.systemId, mode: 'cleanup' }], by)"],
  ['Deactivate', "await validation.lockSources(trx, scope, [{ systemId: hint.systemId, mode: 'cleanup' }], by)"],
  ['Switch', "...(pointerHint ? [{ systemId: pointerHint.systemId, mode: 'cleanup' }] : []),"],
]) test(`mutation: removing ${operation} transactional owner wiring breaks its rebind rejection`, async () => {
  const real = await metadataRace(operation, 'rebind')
  await rejectsCode(real.run(), 'READ_PLAN_SOURCE_INELIGIBLE', 409)
  real.assertUnchanged()
  const mutant = await metadataRace(operation, 'rebind', withoutStoreGuard(needle))
  // The same negative assertion fails only for the independently unwired store.
  let accepted
  await assert.rejects(rejectsCode(mutant.run().then(result => { accepted = result; return result }),
    'READ_PLAN_SOURCE_INELIGIBLE', 409), { code: 'ERR_ASSERTION' })
  assert.ok(accepted?.id, 'the unwired mutation must actually commit, not reject with a different error')
})

test('switch from inactive current binding locks every EXT then every mirror in independently sorted order', async () => {
  const h = harness()
  h.installBound('alpha-source', 'zeta-connection', 'postgres')
  const first = await h.save()
  const next = await h.save('alpha-source')
  for (const [version, connectionId, systemId] of [[first, 'synthetic-connection', 'synthetic-source'], [next, 'zeta-connection', 'alpha-source']]) {
    await seedConfirmedStatusFixture(h.store, h.db, { id: version.id, connectionId })
    await h.mutate('Approve', version.id, systemId)
  }
  await h.mutate('Activate', first.id, undefined, { expectedGeneration: 0 })
  h.db.state.integration_external_systems[0].status = 'inactive'
  h.db.locks.length = 0
  const result = await h.mutate('Activate', next.id, 'alpha-source', { expectedGeneration: 1 })
  assert.equal(result.systemId, 'alpha-source')
  assert.equal(result.generation, 2)
  assert.deepEqual(h.db.locks.map(({ table, where }) => [table, where.id ?? where.data_source_id]), [
    ['integration_external_systems', 'alpha-source'], ['integration_external_systems', 'synthetic-source'],
    [SOURCE_REVISION_TABLE, 'synthetic-connection'], [SOURCE_REVISION_TABLE, 'zeta-connection'],
    [VERSION_TABLE, next.id], [VALIDATION_TABLE, h.db.state[VERSION_TABLE][1].validation_id],
    [ACTIVATION_TABLE, undefined],
  ])
})

test('metadata owner fence preserves mysql and private workspace Connection drafts; validation remains strict', async () => {
  const h = harness()
  h.connections.get('synthetic-connection').type = 'mysql'
  Object.assign(h.db.state[SOURCE_REVISION_TABLE][0], { type: 'mysql', workspace_id: 'owner-workspace' })
  const draft = await h.save()
  assert.equal(draft.status, 'draft')
  await rejectsCode(h.store.beginValidation({ ...SCOPE, actor: 'synthetic-owner', id: draft.id,
    source: { connectionId: 'synthetic-connection', connectionRevision: h.db.state[SOURCE_REVISION_TABLE][0].validation_revision } }),
  'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE', 409)
})

for (const change of [{ is_active: false }, { deleted_at: '2026-10-01T00:00:00Z' }]) {
  test(`stale registration cannot save against a removed current Connection: ${Object.keys(change)[0]}`, async () => {
    const h = harness()
    h.db.beforeTransaction = state => Object.assign(state[SOURCE_REVISION_TABLE][0], change)
    await rejectsCode(h.save(), 'READ_PLAN_SOURCE_INELIGIBLE', 409)
    assert.deepEqual(h.db.state[VERSION_TABLE], [])
    assert.deepEqual(h.db.state[AUDIT_TABLE], [])
  })
}

test('audit rollback remains atomic through handlers and hides driver details', async () => {
  for (const operation of ['Save', 'Approve', 'Retire', 'Activate', 'Deactivate']) {
    const h = harness()
    const saved = operation === 'Save' ? null : await h.save()
    if (saved) await seedConfirmedStatusFixture(h.store, h.db, { id: saved.id, connectionId: 'synthetic-connection' })
    if (['Retire', 'Activate', 'Deactivate'].includes(operation)) await h.mutate('Approve', saved.id)
    if (operation === 'Deactivate') await h.mutate('Activate', saved.id, undefined, { expectedGeneration: 0 })
    h.db.auditFailure = true
    const before = JSON.stringify(h.db.state)
    await rejectsCode(operation === 'Save' ? h.save() : h.mutate(operation, operation === 'Deactivate' ? null : saved.id, undefined,
      ['Activate', 'Deactivate'].includes(operation) ? { expectedGeneration: operation === 'Activate' ? 0 : 1 } : {}), 'READ_PLAN_MANAGEMENT_FAILED', 500)
    assert.equal(JSON.stringify(h.db.state), before)
  }
})

test('stale, missing, string and concurrent generations cannot move an activation', async () => {
  const h = harness()
  const saved = await h.save()
  await seedConfirmedStatusFixture(h.store, h.db, { id: saved.id, connectionId: 'synthetic-connection' })
  await h.mutate('Approve', saved.id)
  for (const expectedGeneration of [undefined, '0', -1, 1.5]) {
    await rejectsCode(h.mutate('Activate', saved.id, undefined, { expectedGeneration }), 'READ_PLAN_GENERATION_INVALID', 400)
  }
  await h.mutate('Activate', saved.id, undefined, { expectedGeneration: 0 })
  await rejectsCode(h.mutate('Activate', saved.id, undefined, { expectedGeneration: 0 }), 'READ_PLAN_GENERATION_CONFLICT')
  const auditCount = h.db.state[AUDIT_TABLE].length
  h.db.beforeTransaction = (state) => { state[ACTIVATION_TABLE][0].generation += 1 }
  await rejectsCode(h.mutate('Activate', saved.id, undefined, { expectedGeneration: 1 }), 'READ_PLAN_GENERATION_CONFLICT')
  assert.equal(h.db.state[AUDIT_TABLE].length, auditCount)
  h.db.beforeTransaction = (state) => { state[ACTIVATION_TABLE][0].generation += 1 }
  await rejectsCode(h.mutate('Deactivate', null, undefined, { expectedGeneration: 2 }), 'READ_PLAN_GENERATION_CONFLICT')
  assert.equal(h.db.state[AUDIT_TABLE].length, auditCount)
})

test('missing metadata boundary fails closed without ledger access', async () => {
  const h = harness()
  const management = createStockPreparationReadPlanManagement({ store: h.store, externalSystemRegistry: {} })
  const handlers = createStockPreparationReadPlanManagementHandlers({ management, helpers: h.helpers })
  await rejectsCode(handlers.stockPreparationReadPlanConfigsList({ user: { id: 'synthetic-owner', permissions: ['integration:admin'] },
    authenticatedTenantId: SCOPE.tenantId, query: { managementScope: 'tenant', systemId: 'synthetic-source' } }, {}), 'READ_PLAN_MANAGEMENT_UNAVAILABLE', 501)
  assert.deepEqual(h.db.trace, [])
})
