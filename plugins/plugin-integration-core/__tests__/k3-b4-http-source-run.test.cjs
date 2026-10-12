'use strict'

// The seam under test starts at the registered HTTP handler and ends at the host records API.
// DB, credential vault, K3 fetch, and host records are in memory; no JWT middleware,
// physical transaction, or host row authorization is claimed.
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')
const { registerIntegrationRoutes } = require('../lib/http-routes.cjs')
const { createReadSourceConfigStore } = require('../lib/read-source-config-store.cjs')
const { createExternalSystemRegistry } = require('../lib/external-systems.cjs')
const { createConnectionResolver } = require('../lib/connection-resolver.cjs')
const { createAdapterRegistry } = require('../lib/contracts.cjs')
const { createK3WiseWebApiAdapter } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')
const { buildK3WiseMaterialListB4Config } = require('../lib/read-source-k3-material-list-b4-contract.cjs')
const { MATERIAL_OBJECT_ID, RUN_OBJECT_ID } = require('../lib/stock-preparation-erp-material-sync-persist.cjs')

const TENANT = 'synthetic-tenant'
const WORKSPACE = 'synthetic-workspace'
const SYSTEM_ID = 'synthetic-k3-b4-system'
const BASE_URL = 'https://synthetic-k3.invalid'
const SESSION = 'synthetic-private-session'
const ROUTE = '/api/integration/stock-preparation/mvp/source-runs/erp-materials'
const READ_ROUTE = '/api/integration/read-source-configs/:id/read'
const ADMIN = { id: 'synthetic-admin', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] }
const READER = { id: 'synthetic-reader', tenantId: TENANT, roles: [], permissions: ['integration:read'] }

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => value === null || value === undefined
    ? row[key] === null || row[key] === undefined : row[key] === value)
}

function memoryDb() {
  const reads = []
  const writes = []
  const tables = {
    integration_external_systems: [],
    integration_read_source_configs: [],
    integration_read_source_config_audit: [],
  }
  const table = (name) => {
    assert.ok(Object.hasOwn(tables, name), `unexpected DB table ${name}`)
    return tables[name]
  }
  const db = {
    tables,
    reads,
    writes,
    async selectOne(name, where) {
      reads.push({ table: name, where: clone(where) })
      return table(name).find((row) => matches(row, where)) || null
    },
    async selectOneForKeyShare(name, where) { return this.selectOne(name, where) },
    async select(name, options = {}) {
      return table(name).filter((row) => matches(row, options.where)).slice(options.offset || 0, (options.offset || 0) + (options.limit || 10000))
    },
    async insertOne(name, row) {
      writes.push({ op: 'insert', table: name })
      const stored = { ...clone(row), created_at: '2026-09-30T00:00:00.000Z', updated_at: '2026-09-30T00:00:00.000Z' }
      table(name).push(stored)
      return [stored]
    },
    async updateRow(name, set, where) {
      writes.push({ op: 'update', table: name })
      const row = await this.selectOne(name, where)
      if (!row) return []
      Object.assign(row, clone(set), { updated_at: '2026-09-30T01:00:00.000Z' })
      return [row]
    },
    async deleteRows(name, where) {
      writes.push({ op: 'delete', table: name })
      const rows = table(name)
      let removed = 0
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (matches(rows[i], where)) { rows.splice(i, 1); removed += 1 }
      }
      return removed
    },
    async countRows(name, where) { return table(name).filter((row) => matches(row, where)).length },
    async setTransactionIsolationLevel() {},
    async transaction(operation) { return operation(this) },
  }
  return db
}

function rowAt(index) {
  return {
    FItemID: `synthetic-item-${index}`,
    FNumber: `SYN-MAT-${index}`,
    FName: `Synthetic material ${index}`,
    FModel: `Synthetic spec ${index}`,
    FUnitID: `SYN-UNIT-${index}`,
    FSecret: 'SYNTHETIC-UNMAPPED-PRIVATE',
  }
}
function page(rows, index, total = 11) {
  return { StatusCode: 200, Data: { PAGEINDEX: index, PAGESIZE: 10, ROWCOUNT: total, DATA: rows } }
}
const goodPages = () => [page(Array.from({ length: 10 }, (_, i) => rowAt(i + 1)), 1), page([rowAt(11)], 2)]

function hostRecords() {
  const sheets = new Map()
  const writes = []
  const targetCalls = []
  const provisioningCalls = []
  let sequence = 0
  const rows = (sheetId) => {
    if (!sheets.has(sheetId)) sheets.set(sheetId, new Map())
    return sheets.get(sheetId)
  }
  const records = {
    async queryRecords({ sheetId, filters }) {
      return [...rows(sheetId).values()].filter((row) => matches(row.data, filters))
        .map((row) => clone(row))
    },
    async createRecord({ sheetId, data }) {
      const record = { id: `host-row-${++sequence}`, sheetId, data: clone(data) }
      rows(sheetId).set(record.id, record)
      writes.push({ op: 'create', sheetId, data: clone(data) })
      return clone(record)
    },
    async patchRecord({ sheetId, recordId, changes }) {
      const record = rows(sheetId).get(recordId)
      assert.ok(record)
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete record.data[key]
        else record.data[key] = value
      }
      writes.push({ op: 'patch', sheetId, data: clone(changes) })
      return clone(record)
    },
  }
  const provisioning = {
    async findObjectSheet({ projectId, objectId }) {
      provisioningCalls.push('findObjectSheet')
      targetCalls.push({ projectId, objectId })
      assert.ok([MATERIAL_OBJECT_ID, RUN_OBJECT_ID].includes(objectId))
      return { id: `sheet-${objectId}` }
    },
    async resolveFieldIds({ fieldIds }) {
      provisioningCalls.push('resolveFieldIds')
      return Object.fromEntries(fieldIds.map((id) => [id, `physical-${id}`]))
    },
  }
  return { records, provisioning, writes, sheets, targetCalls, provisioningCalls }
}

function inert(methods) {
  return Object.fromEntries(methods.map((method) => [method, async () => { throw new Error(`unexpected ${method}`) }]))
}

function harness(payloads = goodPages()) {
  const db = memoryDb()
  db.tables.integration_external_systems.push({
    id: SYSTEM_ID, tenant_id: TENANT, workspace_id: WORKSPACE, project_id: null,
    name: 'Synthetic K3', kind: 'erp:k3-wise-webapi', role: 'source', status: 'active',
    config: { baseUrl: BASE_URL, objects: { material: {} } },
    credentials_encrypted: `enc:${SESSION}`,
  })
  let credentialReads = 0
  const credentialStore = {
    async encrypt(value) { return `enc:${value}` },
    async decrypt(value) {
      credentialReads += 1
      assert.equal(value, `enc:${SESSION}`)
      return JSON.stringify({ sessionId: SESSION })
    },
    async fingerprint() { return 'synthetic-fingerprint' },
  }
  let connectionResolutionCalls = 0
  const connectionResolver = createConnectionResolver({
    facade: { async resolveConnectionRegistration() { connectionResolutionCalls += 1; throw new Error('K3 must pass through') } },
  })
  const externalSystemRegistry = createExternalSystemRegistry({ db, credentialStore, connectionResolver })
  let configSequence = 0
  const readSourceConfigStore = createReadSourceConfigStore({ db, idGenerator: () => `server-minted-b4-config-${++configSequence}` })
  const fetchCalls = []
  const fetchImpl = async (url, options) => {
    const index = fetchCalls.length
    const call = { path: new URL(url).pathname, method: options.method, body: options.body ? JSON.parse(options.body) : null }
    fetchCalls.push(call)
    if (typeof payloads !== 'function') assert.ok(index < payloads.length * 2, 'unexpected K3 page')
    const payload = typeof payloads === 'function' ? await payloads(call, index) : payloads[index % payloads.length]
    return { ok: true, status: 200, async text() { return JSON.stringify(payload) } }
  }
  const adapterCreations = []
  const adapterRegistry = createAdapterRegistry().registerAdapter(
    'erp:k3-wise-webapi', (input) => {
      adapterCreations.push({ id: input.system.id, kind: input.system.kind })
      return createK3WiseWebApiAdapter({ ...input, fetchImpl })
    },
  )
  const host = hostRecords()
  const routes = new Map()
  const context = {
    api: {
      http: { addRoute(method, path, handler) { routes.set(`${method} ${path}`, handler) } },
      multitable: { records: host.records, provisioning: host.provisioning },
    },
    config: {},
  }
  registerIntegrationRoutes({ context, services: {
    externalSystemRegistry, adapterRegistry, readSourceConfigStore,
    pipelineRegistry: inert(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: inert(['runPipeline']), deadLetterStore: inert(['listDeadLetters']),
    stagingInstaller: inert(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inert(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceCompositionConfigStore: inert(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inert(['saveVersion', 'approve', 'retire', 'getForApply']),
  }, logger: { info() {}, warn() {}, error() {} } })
  const httpCalls = []
  const call = async (method, path, { user = ADMIN, body = {}, query = {}, params = {} } = {}) => {
    httpCalls.push({ method, path, body: clone(body), query: clone(query), params: clone(params) })
    const handler = routes.get(`${method} ${path}`)
    assert.equal(typeof handler, 'function', `${method} ${path} registered`)
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this }, json(value) { this.body = value; return this } }
    await handler({ user, body, query, params }, res)
    assert.notEqual(res.body, undefined)
    return res
  }
  const saveDraft = async (config = buildK3WiseMaterialListB4Config({ systemId: SYSTEM_ID })) => {
    const saved = await call('POST', '/api/integration/read-source-configs', {
      body: { config },
      query: { workspaceId: WORKSPACE },
    })
    assert.equal(saved.statusCode, 201, JSON.stringify(saved.body))
    assert.equal(saved.body.data.status, 'draft')
    return saved.body.data.id
  }
  const mint = async (config = buildK3WiseMaterialListB4Config({ systemId: SYSTEM_ID })) => {
    const id = await saveDraft(config)
    const approved = await call('POST', '/api/integration/read-source-configs/:id/approve', {
      params: { id }, query: { workspaceId: WORKSPACE },
    })
    assert.equal(approved.statusCode, 200, JSON.stringify(approved.body))
    const stored = await readSourceConfigStore.getForRuntime({ tenantId: TENANT, workspaceId: WORKSPACE, id })
    assert.equal(stored.status, 'approved')
    assert.equal(stored.config.systemId, config.systemId)
    return id
  }
  const run = (id, options = {}) => call('POST', ROUTE, {
    ...options,
    body: { readSourceConfigId: id, syncRunId: 'synthetic-run-private', workspaceId: WORKSPACE, ...options.body },
  })
  const read = (id, options = {}) => call('POST', READ_ROUTE, {
    user: READER,
    ...options,
    params: { id, ...options.params },
    query: { workspaceId: WORKSPACE, ...options.query },
    body: { inputs: {}, rowSource: 'adapter_records', ...options.body },
  })
  const lookup = (id, key, options = {}) => call('POST', READ_ROUTE, {
    user: READER,
    ...options,
    params: { id, ...options.params },
    query: { workspaceId: WORKSPACE, ...options.query },
    body: Object.hasOwn(options, 'body') ? options.body : { inputs: { key } },
  })
  return {
    db, host, fetchCalls, adapterCreations, httpCalls, call, saveDraft, mint, run, read, lookup,
    get connectionResolutionCalls() { return connectionResolutionCalls },
    get credentialReads() { return credentialReads },
  }
}

// BL2 uses the existing backend contract, not a new adapter or permission surface.
// The frontend shortcut fixes bom_number; other historical targets remain backend-compatible.
function bl2Config({ systemId = SYSTEM_ID, readPath = '/K3API/BOM/GetList' } = {}) {
  return {
    version: 1, systemId, requiredKind: 'erp:k3-wise-webapi', object: 'material-bom-list',
    mode: 'resolver_lookup', readMethod: 'POST', readPath, operations: ['read'],
    keyField: 'FPercentItemID', keyEncoding: 'numeric_id', containerPaths: ['Data.DATA'],
    resolverRule: 'exactly_one', fieldMap: [{ source: 'FBOMNumber', target: 'bom_number' }],
  }
}

function assertValuesFree(response) {
  const serialized = JSON.stringify(response.body)
  for (const value of [BASE_URL, SESSION, SYSTEM_ID, 'SYN-MAT-', 'Synthetic material', 'Synthetic spec', 'SYN-UNIT-', 'SYNTHETIC-UNMAPPED-PRIVATE', 'synthetic-run-private']) {
    assert.equal(serialized.includes(value), false, `HTTP response leaked ${value}`)
  }
}

async function withFlag(value, operation) {
  const previous = process.env.MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED
  try {
    if (value === undefined) delete process.env.MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED
    else process.env.MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED = value
    return await operation()
  } finally {
    if (previous === undefined) delete process.env.MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED
    else process.env.MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED = previous
  }
}

test('B4 HTTP route mints and approves a real config; default OFF reads 10+1 pages without internal writes', async () => {
  await withFlag(undefined, async () => {
    const h = harness()
    const id = await h.mint()
    const response = await h.run(id)
    assert.equal(response.statusCode, 200, JSON.stringify(response.body))
    assert.equal(response.body.data.status, 'ready')
    assert.equal(response.body.data.mode, 'dry_run')
    assert.equal(response.body.data.evidence.sourceRows, 11)
    assert.equal(response.body.data.evidence.internalWriteExecuted, false)
    assert.equal(response.body.data.evidence.externalWriteExecuted, false)
    assert.equal(h.fetchCalls.length, 2)
    for (const [index, call] of h.fetchCalls.entries()) {
      assert.equal(call.path, '/K3API/Material/GetList')
      assert.equal(call.method, 'POST')
      assert.equal(call.body.Data.PageIndex, index + 1)
      assert.equal(call.body.Data.PageSize, 10)
      assert.equal(call.body.Data.Fields, 'FItemID,FNumber,FName,FModel,FUnitID')
    }
    assert.equal(h.host.writes.length, 0)
    assert.equal(h.connectionResolutionCalls, 0)
    assertValuesFree(response)
  })
})

test('B4 exact true flag persists normalized material rows; replay refreshes without duplicate creates', async () => {
  await withFlag('true', async () => {
    const h = harness()
    const id = await h.mint()
    const first = await h.run(id)
    assert.equal(first.statusCode, 201, JSON.stringify(first.body))
    assert.equal(first.body.data.mode, 'internal_persist')
    assert.equal(first.body.data.evidence.internalWriteExecuted, true)
    assert.equal(first.body.data.evidence.externalWriteExecuted, false)
    assert.equal(first.body.data.autoPersist.created.materials, 11)
    assert.equal(first.body.data.autoPersist.created.run, 1)
    assert.deepEqual(new Set(h.host.targetCalls.map((call) => call.projectId)), new Set([`${TENANT}:integration-core`]))
    const materialWrites = h.host.writes.filter((write) => write.sheetId === `sheet-${MATERIAL_OBJECT_ID}`)
    assert.equal(materialWrites.length, 11)
    assert.equal(materialWrites[0].data['physical-erpMaterialCode'], 'SYN-MAT-1')
    assert.equal(materialWrites[0].data['physical-erpMaterialInternalId'], 'synthetic-item-1')
    assert.equal(materialWrites[0].data['physical-erpMaterialName'], 'Synthetic material 1')
    assert.equal(materialWrites[0].data['physical-erpSpec'], 'Synthetic spec 1')
    assert.equal(materialWrites[0].data['physical-baseUnit'], 'SYN-UNIT-1')
    assert.equal(JSON.stringify(h.host.writes).includes('SYNTHETIC-UNMAPPED-PRIVATE'), false)
    const runWrites = h.host.writes.filter((write) => write.sheetId === `sheet-${RUN_OBJECT_ID}`)
    assert.equal(runWrites.length, 1)
    assert.equal(runWrites[0].data['physical-runType'], 'erp_material_sync')
    const second = await h.run(id)
    assert.equal(second.statusCode, 201, JSON.stringify(second.body))
    assert.equal(second.body.data.autoPersist.created.materials, 0)
    assert.equal(second.body.data.autoPersist.patched.materials, 11)
    assert.equal(h.host.writes.filter((write) => write.op === 'create').length, 12)
    assert.equal(h.host.sheets.get(`sheet-${MATERIAL_OBJECT_ID}`).size, 11)
    assert.equal(h.host.sheets.get(`sheet-${RUN_OBJECT_ID}`).size, 1)
    assert.equal(h.fetchCalls.length, 4)
    assert.ok(h.fetchCalls.every((call) => call.path === '/K3API/Material/GetList' && call.method === 'POST'))
    assert.equal(h.connectionResolutionCalls, 0)
    assertValuesFree(first)
    assertValuesFree(second)
  })
})

test('B4 status, scope, permission and steering guards reject before fetch and persist', async () => {
  await withFlag('true', async () => {
    const h = harness()
    const id = await h.mint()
    const saved = await h.call('POST', '/api/integration/read-source-configs', {
      body: { config: buildK3WiseMaterialListB4Config({ systemId: SYSTEM_ID }) },
      query: { workspaceId: 'other-workspace' },
    })
    assert.equal(saved.statusCode, 201)
    const draftId = saved.body.data.id
    const cases = [
      [() => h.run(draftId, { body: { workspaceId: 'other-workspace' } }), 409],
      [() => h.run(id, { body: { workspaceId: 'other-workspace' } }), 404],
      [() => h.run(id, { user: { id: 'other', tenantId: 'other-tenant', roles: ['admin'], permissions: ['integration:admin'] } }), 404],
      [() => h.run(id, { user: { id: 'reader', tenantId: TENANT, permissions: ['integration:read'] } }), 403],
      [() => h.run(id, { body: { tenantId: 'other-tenant' } }), 400],
      [() => h.run(id, { body: { projectId: 'other-project' } }), 400],
      [() => h.run(id, { body: { readPath: '/K3API/Other/GetList' } }), 400],
      [() => h.run(id, { body: { inputs: { pageSize: 999 } } }), 400],
    ]
    for (const [invoke, status] of cases) {
      const result = await invoke()
      assert.equal(result.statusCode, status, JSON.stringify(result.body))
      assertValuesFree(result)
      assert.equal(h.fetchCalls.length, 0)
      assert.equal(h.host.writes.length, 0)
    }
    const transition = await h.call('POST', '/api/integration/read-source-configs/:id/retire', {
      params: { id }, query: { workspaceId: WORKSPACE },
    })
    assert.equal(transition.statusCode, 200, JSON.stringify(transition.body))
    assert.equal(transition.body.data.status, 'retired')
    const retired = await h.run(id)
    assert.equal(retired.statusCode, 409, JSON.stringify(retired.body))
    assert.equal(h.fetchCalls.length, 0)
    assert.equal(h.host.targetCalls.length, 0)
    assert.equal(h.host.writes.length, 0)
  })
})

test('B4 same-scope active K3 remains unreachable while its real saved version is draft', async () => {
  await withFlag('true', async () => {
    const h = harness()
    const id = await h.saveDraft()
    const stored = h.db.tables.integration_read_source_configs.find((row) => row.id === id)
    const system = h.db.tables.integration_external_systems.find((row) => row.id === SYSTEM_ID)
    assert.equal(stored.tenant_id, TENANT)
    assert.equal(stored.workspace_id, WORKSPACE)
    assert.equal(stored.system_id, system.id)
    assert.equal(stored.status, 'draft')
    assert.equal(system.tenant_id, TENANT)
    assert.equal(system.workspace_id, WORKSPACE)
    assert.equal(system.status, 'active')
    const result = await h.run(id)
    assert.equal(result.statusCode, 409, JSON.stringify(result.body))
    assert.equal(result.body.error.code, 'READ_SOURCE_CONFIG_NOT_APPROVED')
    assert.equal(result.body.error.details.status, 'draft')
    assert.equal(h.fetchCalls.length, 0)
    assert.equal(h.host.targetCalls.length, 0)
    assert.equal(h.host.writes.length, 0)
    assertValuesFree(result)
  })
})

test('B4 malformed second K3 page fails before the existing ERP committer starts', async () => {
  await withFlag('true', async () => {
    const payloads = [goodPages()[0], { StatusCode: 200, Data: { PAGEINDEX: 2, PAGESIZE: 10, ROWCOUNT: 11, DATA: null } }]
    const h = harness(payloads)
    const id = await h.mint()
    const result = await h.run(id)
    assert.notEqual(result.statusCode, 200)
    assert.equal(h.fetchCalls.length, 2)
    assert.equal(h.host.targetCalls.length, 0)
    assert.equal(h.host.writes.length, 0)
    assertValuesFree(result)
  })
})

// /read is a separate handler contract: it returns mapped values for one bounded page and never
// enters the ERP cache committer, even when the source-run autopersist flag is enabled.
function readBaseline(h) {
  return { tables: clone(h.db.tables), databaseWrites: h.db.writes.length }
}

function assertNoReadWrites(h, baseline) {
  assert.equal(h.db.writes.length, baseline.databaseWrites, 'the read did not write configuration or audit rows')
  assert.deepEqual(h.db.tables, baseline.tables)
  assert.deepEqual(h.host.writes, [], 'no ERP material cache or run records were written')
  assert.deepEqual(h.host.provisioningCalls, [], 'read did not resolve or provision business targets')
  assert.equal(h.host.sheets.size, 0, 'read did not enter the host records store')
}

function assertNoExternalRead(h) {
  assert.equal(h.credentialReads, 0, 'guard rejected before credential decryption')
  assert.deepEqual(h.adapterCreations, [], 'guard rejected before the real adapter was created')
  assert.deepEqual(h.fetchCalls, [], 'guard rejected before the external read')
}

function assertReadEvidenceValuesFree(evidence) {
  assertValuesFree({ body: evidence })
  const serialized = JSON.stringify(evidence)
  for (const value of [TENANT, WORKSPACE, 'server-minted-b4-config-', 'synthetic-item-',
    'FItemID', 'FNumber', 'FName', 'FModel', 'FUnitID', 'baseUnit', 'FSecret', '/K3API/',
    'SYNTHETIC-UPSTREAM-PRIVATE']) {
    assert.equal(serialized.includes(value), false, `configured-read evidence leaked ${value}`)
  }
}

for (const [label, flag] of [['OFF', undefined], ['ON', 'true']]) {
  test(`B4 /read with autopersist ${label} returns only the selected approved config first page to a read-only user`, async () => {
    await withFlag(flag, async () => {
      const h = harness()
      // Mint an approved decoy first through the real routes. Runtime must load the chosen id,
      // rather than select the first available approved B4 configuration/system.
      const decoySystemId = 'synthetic-decoy-k3-system'
      h.db.tables.integration_external_systems.push({
        ...clone(h.db.tables.integration_external_systems[0]), id: decoySystemId,
      })
      const decoy = await h.call('POST', '/api/integration/read-source-configs', {
        body: { config: buildK3WiseMaterialListB4Config({ systemId: decoySystemId }) },
        query: { workspaceId: WORKSPACE },
      })
      assert.equal(decoy.statusCode, 201)
      const decoyApproved = await h.call('POST', '/api/integration/read-source-configs/:id/approve', {
        params: { id: decoy.body.data.id }, query: { workspaceId: WORKSPACE },
      })
      assert.equal(decoyApproved.statusCode, 200)
      const id = await h.mint()
      assert.notEqual(id, decoy.body.data.id)
      const baseline = readBaseline(h)
      const readsBefore = h.db.reads.length
      assert.deepEqual(READER.permissions, ['integration:read'])
      assert.deepEqual(READER.roles, [])
      const response = await h.read(id)
      assert.equal(response.statusCode, 200, JSON.stringify(response.body))
      assert.equal(response.body.ok, true)
      const { evidence, data } = response.body.data
      assert.equal(evidence.ok, true)
      assert.equal(evidence.boundedSmoke, true)
      assert.equal(evidence.boundedSmokeExecuted, true)
      assert.equal(evidence.recordCount, 10)
      assert.equal(evidence.capReached, true)
      assert.equal(data.recordCount, 10)
      assert.deepEqual(data.containers.primary.records, Array.from({ length: 10 }, (_, index) => {
        const row = rowAt(index + 1)
        return { FItemID: row.FItemID, FNumber: row.FNumber, FName: row.FName, FModel: row.FModel, baseUnit: row.FUnitID }
      }))
      assert.deepEqual(Object.keys(response.body.data).sort(), ['data', 'evidence'])
      assert.equal(JSON.stringify(data).includes('SYNTHETIC-UNMAPPED-PRIVATE'), false)
      assert.deepEqual(h.db.reads.slice(readsBefore).filter((read) => read.table === 'integration_read_source_configs'), [
        { table: 'integration_read_source_configs', where: { tenant_id: TENANT, workspace_id: WORKSPACE, id } },
      ])
      assert.deepEqual(h.adapterCreations, [{ id: SYSTEM_ID, kind: 'erp:k3-wise-webapi' }])
      assert.equal(h.credentialReads, 1)
      assert.equal(h.connectionResolutionCalls, 0)
      assert.equal(h.fetchCalls.length, 1, 'one /read stops at page one even when the upstream total is eleven')
      assert.equal(h.fetchCalls[0].path, '/K3API/Material/GetList')
      assert.equal(h.fetchCalls[0].method, 'POST')
      assert.deepEqual(h.fetchCalls[0].body.Data, {
        Top: 10, PageSize: 10, PageIndex: 1, OrderBy: 'FNumber',
        Fields: 'FItemID,FNumber,FName,FModel,FUnitID',
      })
      assertReadEvidenceValuesFree(evidence)
      assertNoReadWrites(h, baseline)
    })
  })
}

test('B4 /read malformed first-page responses return failed values-free evidence and no data or cache writes', async () => {
  await withFlag('true', async () => {
    const malformedPages = [
      [{ StatusCode: 200, Message: 'SYNTHETIC-UPSTREAM-PRIVATE', Data: { DATA: null } }, 'READ_SOURCE_PROBE_SHAPE_MISMATCH'],
      [page([rowAt(1), 'SYNTHETIC-UPSTREAM-PRIVATE'], 1, 2), 'READ_SOURCE_PROBE_SHAPE_MISMATCH'],
      [page(Array.from({ length: 11 }, (_, index) => rowAt(index + 1)), 1), 'READ_SOURCE_PROBE_CAP_REACHED'],
      [page([rowAt(1)], 2, 1), 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED'],
    ]
    for (const [payload, errorCode] of malformedPages) {
      const h = harness([payload])
      const id = await h.mint()
      const baseline = readBaseline(h)
      const response = await h.read(id)
      // This is the production API's read-level failure envelope. HTTP/outer success alone is
      // insufficient for the caller; evidence.ok controls whether any data can be consumed.
      assert.equal(response.statusCode, 200, JSON.stringify(response.body))
      assert.equal(response.body.ok, true)
      assert.equal(response.body.data.evidence.ok, false)
      assert.equal(response.body.data.evidence.errorCode, errorCode)
      assert.equal(response.body.data.data, null)
      assert.equal(h.fetchCalls.length, 1)
      assert.equal(h.fetchCalls[0].path, '/K3API/Material/GetList')
      assert.equal(h.fetchCalls[0].method, 'POST')
      assertReadEvidenceValuesFree(response.body.data.evidence)
      assertValuesFree(response)
      assertNoReadWrites(h, baseline)
    }
  })
})

const DRAFT_READ_TEST = 'B4 /read rejects a same-scope draft before credential resolution or external read'
for (const status of ['draft', 'retired']) {
  test(status === 'draft' ? DRAFT_READ_TEST : 'B4 /read rejects a same-scope retired version before credential resolution or external read', async () => {
    await withFlag('true', async () => {
      const h = harness()
      const id = status === 'draft' ? await h.saveDraft() : await h.mint()
      if (status === 'retired') {
        const response = await h.call('POST', '/api/integration/read-source-configs/:id/retire', {
          params: { id }, query: { workspaceId: WORKSPACE },
        })
        assert.equal(response.statusCode, 200)
      }
      const stored = h.db.tables.integration_read_source_configs.find((row) => row.id === id)
      const system = h.db.tables.integration_external_systems.find((row) => row.id === stored.system_id)
      assert.equal(stored.status, status)
      assert.equal(stored.tenant_id, READER.tenantId)
      assert.equal(stored.workspace_id, WORKSPACE)
      assert.equal(system.tenant_id, stored.tenant_id)
      assert.equal(system.workspace_id, stored.workspace_id)
      assert.equal(system.status, 'active')
      const baseline = readBaseline(h)
      const response = await h.read(id)
      assert.equal(response.statusCode, 409, 'non-approved runtime read must be refused')
      assert.equal(response.body.error.code, 'READ_SOURCE_CONFIG_NOT_APPROVED')
      assert.equal(response.body.error.details.status, status)
      assertValuesFree(response)
      assertNoExternalRead(h)
      assertNoReadWrites(h, baseline)
    })
  })
}

for (const [label, options] of [
  ['tenant', { user: { ...READER, tenantId: 'other-tenant' } }],
  ['workspace', { query: { workspaceId: 'other-workspace' } }],
]) {
  test(`B4 /read refuses an approved selected id from another ${label} before external read`, async () => {
    await withFlag('true', async () => {
      const h = harness()
      const id = await h.mint()
      const baseline = readBaseline(h)
      const response = await h.read(id, options)
      assert.equal(response.statusCode, 404, JSON.stringify(response.body))
      assert.equal(response.body.error.code, 'READ_SOURCE_CONFIG_NOT_FOUND')
      assertValuesFree(response)
      assertNoExternalRead(h)
      assertNoReadWrites(h, baseline)
    })
  })
}

test('B4 /read refuses a same-scope approved config when the caller lacks read permission', async () => {
  await withFlag('true', async () => {
    const h = harness()
    const id = await h.mint()
    const baseline = readBaseline(h)
    const readsBefore = h.db.reads.length
    const response = await h.read(id, { user: { ...READER, permissions: [] } })
    assert.equal(response.statusCode, 403, JSON.stringify(response.body))
    assert.equal(response.body.error.code, 'FORBIDDEN')
    assert.equal(h.db.reads.length, readsBefore, 'permission is checked before config lookup')
    assertValuesFree(response)
    assertNoExternalRead(h)
    assertNoReadWrites(h, baseline)
  })
})

test('B4 /read rejects request-side cap, endpoint, field and row-plane steering before external read', async () => {
  await withFlag('true', async () => {
    const h = harness()
    const id = await h.mint()
    const baseline = readBaseline(h)
    for (const body of [
      { rowCap: 1000 }, { readPath: '/K3API/Other/GetList' },
      { fields: ['FSecret'] }, { inputs: { pageSize: 1000 } }, { rowSource: 'other_rows' },
    ]) {
      const response = await h.read(id, { body })
      assert.equal(response.statusCode, 400, JSON.stringify(response.body))
      assert.equal(response.body.error.code, 'READ_SOURCE_READ_CONTRACT_INVALID')
      assertValuesFree(response)
      assertNoExternalRead(h)
      assertNoReadWrites(h, baseline)
    }
  })
})

test('B4 /read draft regression test kills a memory-only removal of the real store approval guard', (t) => {
  // Each child loads the same production modules and test. Only the mutant's in-memory compilation
  // drops the store guard; no production source, environment file, or preload file is changed.
  const script = `
    const assert = require('node:assert/strict')
    const Module = require('node:module')
    const target = require.resolve(process.argv[2])
    const originalCompile = Module.prototype._compile
    let changed = false
    Module.prototype._compile = function (source, filename) {
      if (filename === target && process.argv[3] === 'mutant') {
        const guard = "if (row.status !== 'approved') {"
        assert.equal(source.split(guard).length - 1, 1, 'approval mutation has exactly one target')
        source = source.replace(guard, 'if (false) {')
        changed = true
      }
      return originalCompile.call(this, source, filename)
    }
    require(process.argv[1])
    assert.equal(changed, process.argv[3] === 'mutant')
  `
  const childEnvironment = { ...process.env }
  // The parent test runner's IPC mode would otherwise replace the requested TAP text reporter.
  delete childEnvironment.NODE_TEST_CONTEXT
  for (const mode of ['baseline', 'mutant']) {
    const result = spawnSync(process.execPath, [
      '--test-reporter=tap', `--test-name-pattern=^${DRAFT_READ_TEST}$`, '-e', script,
      __filename, require.resolve('../lib/read-source-config-store.cjs'), mode,
    ], { encoding: 'utf8', timeout: 30000, env: childEnvironment })
    assert.ifError(result.error)
    const output = result.stdout + result.stderr
    if (mode === 'baseline') {
      assert.equal(result.status, 0, output)
      assert.match(output, /# pass 1\b/)
      assert.match(output, /# fail 0\b/)
    } else {
      assert.equal(result.status, 1, output)
      assert.match(output, /# fail 1\b/)
      assert.match(output, /non-approved runtime read must be refused/)
      assert.match(output, /expected: 409/)
      assert.match(output, /actual: 200/)
    }
  }
  t.diagnostic('Approval guard mutation: baseline 1 passed; memory-only mutant 1 failed (expected 409, actual 200).')
})

function bl2Raw(rows, metadata = {}) {
  return { StatusCode: 200, Message: 'SYNTHETIC-UPSTREAM-PRIVATE', Data: {
    ROWCOUNT: Array.isArray(rows) ? rows.length : 0, PAGESIZE: 10, PAGEINDEX: 1, DATA: rows, ...metadata,
  } }
}

function assertBl2EvidenceValuesFree(evidence, key = '00090071992547409931') {
  assertReadEvidenceValuesFree(evidence)
  const serialized = JSON.stringify(evidence)
  for (const value of [key, 'SYN-BOM-', 'SYN-RAW-PRIVATE', 'FBOMNumber', 'FPercentItemID', 'bom_number']) {
    assert.equal(serialized.includes(value), false, 'BL2 evidence must not contain the input, BOM value or field mapping')
  }
}

for (const [label, flag] of [['OFF', undefined], ['ON', 'true']]) {
  for (const readPath of ['/K3API/BOM/GetList', '/BOM/GetList', 'synthetic-prefix/BOM/GetList']) {
    test(`BL2 /read ${readPath}, autopersist ${label}: actual approved lookup uses only the selected config and fixed request`, async () => {
      await withFlag(flag, async () => {
        const h = harness([bl2Raw([{ FBOMNumber: 'SYN-BOM-UNIQUE', FSecret: 'SYN-RAW-PRIVATE' }])])
        const decoySystem = 'synthetic-decoy-bl2-system'
        h.db.tables.integration_external_systems.push({ ...clone(h.db.tables.integration_external_systems[0]), id: decoySystem })
        const decoy = await h.mint(bl2Config({ systemId: decoySystem }))
        const id = await h.mint(bl2Config({ readPath }))
        assert.notEqual(decoy, id)
        const baseline = readBaseline(h)
        const readsBefore = h.db.reads.length
        const key = '00090071992547409931'
        const response = await h.lookup(id, key)
        assert.equal(response.statusCode, 200)
        assert.equal(response.body.ok, true)
        assert.deepEqual(Object.keys(response.body.data).sort(), ['data', 'evidence'])
        assert.deepEqual(response.body.data.data, { resolver: { target: 'bom_number', value: 'SYN-BOM-UNIQUE' } })
        assert.deepEqual(response.body.data.evidence, {
          ok: true, object: 'material-bom-list', mode: 'resolver_lookup', boundedSmoke: false,
          containers: { primary: { type: 'array', arrayLength: 1 } }, candidateCount: 1,
          matchedCount: 1, containerLocated: true, resolved: true, rule: 'exactly_one',
        })
        assert.equal(Object.hasOwn(response.body.data.evidence, 'boundedSmokeExecuted'), false)
        assert.deepEqual(h.httpCalls.at(-1), { method: 'POST', path: READ_ROUTE, params: { id },
          query: { workspaceId: WORKSPACE }, body: { inputs: { key } } })
        assert.deepEqual(h.db.reads.slice(readsBefore).filter(read => read.table === 'integration_read_source_configs'), [
          { table: 'integration_read_source_configs', where: { tenant_id: TENANT, workspace_id: WORKSPACE, id } },
        ])
        assert.deepEqual(h.adapterCreations, [{ id: SYSTEM_ID, kind: 'erp:k3-wise-webapi' }])
        assert.equal(h.credentialReads, 1)
        assert.equal(h.connectionResolutionCalls, 0)
        assert.deepEqual(h.fetchCalls, [{ path: readPath.startsWith('/') ? readPath : `/${readPath}`, method: 'POST', body: {
          Data: { Top: 10, PageSize: 10, PageIndex: 1, Filter: `[FPercentItemID] = ${key}`,
            OrderBy: '', SelectPage: 2, Fields: 'FBOMNumber' },
        } }])
        assertBl2EvidenceValuesFree(response.body.data.evidence, key)
        assertNoReadWrites(h, baseline)
      })
    })
  }
}

for (const [label, raw, errorCode] of [
  ['not found', bl2Raw([]), 'K3_WISE_BOM_LIST_BY_MATERIAL_NOT_FOUND'],
  ['ambiguous', bl2Raw([{ FBOMNumber: 'SYN-BOM-A' }, { FBOMNumber: 'SYN-BOM-B' }]), 'K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS'],
  ['cap reached', bl2Raw(Array.from({ length: 10 }, (_, n) => ({ FBOMNumber: `SYN-BOM-${n}` }))), 'K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS'],
  ['null container', bl2Raw(null), 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH'],
  ['nonrecord candidate', bl2Raw(['SYN-RAW-PRIVATE']), 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH'],
  ['missing result field', bl2Raw([{ FSecret: 'SYN-RAW-PRIVATE' }]), 'K3_WISE_BOM_LIST_BY_MATERIAL_FIELD_MISSING'],
  ['upstream rejected', { StatusCode: 500, Message: 'SYNTHETIC-UPSTREAM-PRIVATE', Data: 'SYN-RAW-PRIVATE' }, 'K3_WISE_BOM_LIST_BY_MATERIAL_REJECTED'],
  ['unseen second match on a smaller accepted page', bl2Raw([{ FBOMNumber: 'SYN-BOM-A' }], { ROWCOUNT: 2, PAGESIZE: 1 }), 'K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS'],
  ['unseen second match despite matching page echo', bl2Raw([{ FBOMNumber: 'SYN-BOM-A' }], { ROWCOUNT: 2 }), 'K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS'],
  ['empty visible page with positive total', bl2Raw([], { ROWCOUNT: 1 }), 'K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS'],
  ['smaller page echo cannot establish the requested window', bl2Raw([{ FBOMNumber: 'SYN-BOM-A' }], { PAGESIZE: 1 }), 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH'],
  ['zero page size', bl2Raw([], { PAGESIZE: 0 }), 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH'],
  ['zero page index', bl2Raw([], { PAGEINDEX: 0 }), 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH'],
  ['wrong page echo', bl2Raw([{ FBOMNumber: 'SYN-BOM-A' }], { PAGEINDEX: 2 }), 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH'],
  ['zero total contradicts a visible candidate', bl2Raw([{ FBOMNumber: 'SYN-BOM-A' }], { ROWCOUNT: 0 }), 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH'],
  ['all pagination metadata missing', { StatusCode: 200, Data: { DATA: [{ FBOMNumber: 'SYN-BOM-A' }] } }, 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH'],
  ['alias-only pagination metadata cannot replace the canonical contract', { StatusCode: 200, Data: { rowCount: 1, pageSize: 10, pageIndex: 1, DATA: [{ FBOMNumber: 'SYN-BOM-A' }] } }, 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH'],
  ['rejected status cannot be overridden by success-like Code', { ...bl2Raw([{ FBOMNumber: 'SYN-BOM-A' }], { Code: 'Y' }), StatusCode: 500 }, 'K3_WISE_BOM_LIST_BY_MATERIAL_REJECTED'],
  ...[undefined, null, 200.5, 'SYN-RAW-PRIVATE'].map((status) => [
    `missing or malformed canonical status ${typeof status}`, { ...bl2Raw([{ FBOMNumber: 'SYN-BOM-A' }], { Code: 'Y' }), StatusCode: status }, 'K3_WISE_BOM_LIST_BY_MATERIAL_REJECTED',
  ]),
  ...['ROWCOUNT', 'PAGESIZE', 'PAGEINDEX'].flatMap((field) => [
    [`missing ${field}`, bl2Raw([{ FBOMNumber: 'SYN-BOM-A' }], { [field]: undefined }), 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH'],
    [`fractional ${field}`, bl2Raw([{ FBOMNumber: 'SYN-BOM-A' }], { [field]: 1.5 }), 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH'],
    [`negative ${field}`, bl2Raw([{ FBOMNumber: 'SYN-BOM-A' }], { [field]: -1 }), 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH'],
    [`unsafe ${field}`, bl2Raw([{ FBOMNumber: 'SYN-BOM-A' }], { [field]: Number.MAX_SAFE_INTEGER + 1 }), 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH'],
    [`nonnumeric ${field}`, bl2Raw([{ FBOMNumber: 'SYN-BOM-A' }], { [field]: 'SYN-RAW-PRIVATE' }), 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH'],
  ]),
]) {
  test(`BL2 /read ${label}: real adapter/evaluator returns exact coarse failure and no data or writes`, async () => {
    for (const flag of [undefined, 'true']) await withFlag(flag, async () => {
      const h = harness([raw])
      const id = await h.mint(bl2Config())
      const baseline = readBaseline(h)
      const response = await h.lookup(id, '31415')
      assert.equal(response.statusCode, 200)
      assert.equal(response.body.ok, true, 'outer HTTP success is not resolver success')
      assert.equal(response.body.data.evidence.ok, false)
      assert.equal(response.body.data.evidence.errorCode, errorCode)
      assert.equal(response.body.data.data, null)
      assert.notEqual(response.body.data.evidence.resolved, true)
      assert.equal(h.fetchCalls.length, 1)
      assert.equal(h.fetchCalls[0].path, '/K3API/BOM/GetList')
      assert.equal(h.fetchCalls[0].method, 'POST')
      assert.deepEqual(h.adapterCreations, [{ id: SYSTEM_ID, kind: 'erp:k3-wise-webapi' }])
      assert.equal(h.credentialReads, 1)
      assert.equal(h.connectionResolutionCalls, 0)
      assertBl2EvidenceValuesFree(response.body.data.evidence, '31415')
      assertValuesFree(response)
      assertNoReadWrites(h, baseline)
    })
  })
}

for (const status of ['draft', 'retired']) {
  test(`BL2 /read ${status} version is denied before vault, adapter and K3`, async () => {
    const h = harness([bl2Raw([{ FBOMNumber: 'SYN-BOM-UNIQUE' }])])
    const id = status === 'draft' ? await h.saveDraft(bl2Config()) : await h.mint(bl2Config())
    if (status === 'retired') {
      const retired = await h.call('POST', '/api/integration/read-source-configs/:id/retire', { params: { id }, query: { workspaceId: WORKSPACE } })
      assert.equal(retired.statusCode, 200)
    }
    const baseline = readBaseline(h)
    const response = await h.lookup(id, '31415')
    assert.equal(response.statusCode, 409)
    assert.equal(response.body.error.code, 'READ_SOURCE_CONFIG_NOT_APPROVED')
    assert.equal(response.body.error.details.status, status)
    assertNoExternalRead(h)
    assertNoReadWrites(h, baseline)
  })
}

for (const [scope, options] of [
  ['tenant', { user: { ...READER, tenantId: 'another-tenant' } }],
  ['workspace', { query: { workspaceId: 'another-workspace' } }],
]) {
  test(`BL2 /read cross-${scope} selected id is denied before K3`, async () => {
    const h = harness([bl2Raw([{ FBOMNumber: 'SYN-BOM-UNIQUE' }])])
    const id = await h.mint(bl2Config())
    const baseline = readBaseline(h)
    const response = await h.lookup(id, '31415', options)
    assert.equal(response.statusCode, 404)
    assert.equal(response.body.error.code, 'READ_SOURCE_CONFIG_NOT_FOUND')
    assertNoExternalRead(h)
    assertNoReadWrites(h, baseline)
  })
}

test('BL2 /read requires read permission before config access, without treating UI confirmation as authority', async () => {
  const h = harness([bl2Raw([{ FBOMNumber: 'SYN-BOM-UNIQUE' }])])
  const id = await h.mint(bl2Config())
  const baseline = readBaseline(h)
  const readsBefore = h.db.reads.length
  const response = await h.lookup(id, '31415', { user: { ...READER, permissions: [] } })
  assert.equal(response.statusCode, 403)
  assert.equal(response.body.error.code, 'FORBIDDEN')
  assert.equal(h.db.reads.length, readsBefore)
  assertNoExternalRead(h)
  assertNoReadWrites(h, baseline)
})

test('BL2 /read rejects runtime config/endpoint/filter/authority steering before vault or K3', async () => {
  const h = harness([bl2Raw([{ FBOMNumber: 'SYN-BOM-UNIQUE' }])])
  const id = await h.mint(bl2Config())
  const baseline = readBaseline(h)
  for (const extra of [
    { config: bl2Config() }, { readPath: '/K3API/BOM/Save' }, { fields: ['FSecret'] },
    { tenantId: TENANT }, { principal: 'synthetic-other' }, { approved: true },
    { rowCap: 999 }, { filter: 'synthetic-private-filter' }, { write: true },
  ]) {
    const response = await h.lookup(id, '31415', { body: { inputs: { key: '31415' }, ...extra } })
    assert.equal(response.statusCode, 400)
    assert.equal(response.body.error.code, 'READ_SOURCE_READ_CONTRACT_INVALID')
    assertNoExternalRead(h)
    assertNoReadWrites(h, baseline)
  }
  // The shared route accepts raw_containers for older consumers; this shortcut sends no rowSource.
  const wrongPlane = await h.lookup(id, '31415', { body: { inputs: { key: '31415' }, rowSource: 'adapter_records' } })
  assert.equal(wrongPlane.statusCode, 400)
  assert.deepEqual(h.fetchCalls, [])
  assertNoReadWrites(h, baseline)
})

test('BL2 /read invalid numeric-id strings cause zero K3 calls and no result or cache writes', async () => {
  for (const key of ['1 OR 1=1', '-1', '1e3', '１２', '9'.repeat(21)]) {
    const h = harness([bl2Raw([{ FBOMNumber: 'SYN-BOM-UNIQUE' }])])
    const id = await h.mint(bl2Config())
    const baseline = readBaseline(h)
    const response = await h.lookup(id, key)
    assert.equal(response.statusCode, 200)
    assert.equal(response.body.data.evidence.ok, false)
    assert.equal(response.body.data.evidence.errorCode, 'K3_WISE_BOM_LIST_BY_MATERIAL_KEY_INVALID')
    assert.equal(response.body.data.data, null)
    assert.deepEqual(h.fetchCalls, [])
    assertBl2EvidenceValuesFree(response.body.data.evidence, key)
    assertNoReadWrites(h, baseline)
  }
})

test('BL2 /read uses current approved stored structure; drift cannot inherit successful earlier evidence', async () => {
  const h = harness(() => bl2Raw([{ FBOMNumber: 'SYN-BOM-UNIQUE' }]))
  const id = await h.mint(bl2Config())
  const first = await h.lookup(id, '31415')
  assert.equal(first.body.data.evidence.ok, true)
  const stored = h.db.tables.integration_read_source_configs.find(row => row.id === id)
  const saved = clone(stored)
  for (const change of [
    { readPath: '/K3API/BOM/Save' }, { keyField: 'FItemID' }, { resolverRule: 'first_when_sorted' },
  ]) {
    Object.assign(stored, clone(saved))
    const config = typeof stored.config === 'string' ? JSON.parse(stored.config) : stored.config
    Object.assign(config, change)
    stored.config = typeof saved.config === 'string' ? JSON.stringify(config) : config
    const callsBefore = h.fetchCalls.length
    const baseline = readBaseline(h)
    const rejected = await h.lookup(id, '31415')
    assert.equal(rejected.statusCode, 400)
    assert.equal(rejected.body.error.code, 'READ_SOURCE_READ_CONTRACT_INVALID')
    assert.equal(h.fetchCalls.length, callsBefore)
    assertNoReadWrites(h, baseline)
  }
})

test('BL2 backend retains generic historical resolver targets; bom_number is this UI shortcut contract', async () => {
  const h = harness([bl2Raw([{ FBOMNumber: 'SYN-BOM-UNIQUE' }])])
  const config = bl2Config()
  config.fieldMap = [{ source: 'FBOMNumber', target: 'historical_bom' }]
  const id = await h.mint(config)
  const baseline = readBaseline(h)
  const response = await h.lookup(id, '31415')
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body.data.data, { resolver: { target: 'historical_bom', value: 'SYN-BOM-UNIQUE' } })
  assertNoReadWrites(h, baseline)
})
