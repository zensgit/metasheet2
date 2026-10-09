'use strict'

// 一个项目一张备料表 — S2 (ADR adr-stock-prep-project-sheets-20261008 §2 「客户包」, register R-36):
// THE DEPLOYMENT'S CUSTOMER PACK, RE-INSTALLED ONTO EACH PROJECT SHEET.
//
// `ensureObject` builds the frozen template's columns and nothing else, so a fresh project sheet has
// no `ext_` column. A deployment whose pull action declares `extensionFieldIds` therefore answered its
// FIRST dry-run on a new project sheet with 422 TARGET_SCHEMA_INCOMPLETE (S1 recorded this as an open
// limitation). S2 re-places the pack the deployment installed on its env object onto the new object.
//
// The real route stack is mounted; the registry store and the pack-install ledger are the REAL stores
// over one in-memory db; the host provisioning keeps real per-object field sets, so the dry-run's own
// DB-backed field-existence probe judges what the installer actually landed.
//
//   PK-01 CREATE: the pack lands on the PROJECT object (never the env object), the ledger records it
//         there, the registry row is written AFTER the install, two audit rows (sheet_created +
//         customer_pack_installed, values-free), and the response reports the carry-over counts.
//   PK-02 THE 422 IS GONE: the first dry-run on the new sheet is 200 'ready' and the existence probe
//         asked about the ext columns on the project object.
//   PK-03 A SHEET REGISTERED WITHOUT ITS PACK (S1's limitation, reproduced) answers the dry-run 422
//         TARGET_SCHEMA_INCOMPLETE naming exactly the ext ids; the 200 replay HEALS it (pack
//         installed, audited) and the next dry-run is 200.
//   PK-04 IDEMPOTENT REPLAY: a second POST installs nothing (no installer host call, no audit row),
//         answers alreadyInstalled 1 — a pack already live on the project object is never re-run.
//   PK-05 A FAILED INSTALL LEAVES NO REGISTERED ROW: the host refuses the ext columns → the create
//         answers STOCK_PREPARATION_PROJECT_TARGET_PACK_INSTALL_FAILED with the pack id and the
//         installer's own code, the registry is empty, no audit row; the SAME POST once the host
//         recovers registers the sheet with its pack.
//   PK-06 A BAND NO PACK CAN COVER is refused 409 STOCK_PREPARATION_PROJECT_TARGET_PACK_INCOMPLETE
//         BEFORE anything is provisioned (no ledger row on the env object; and a ledger pack this
//         server's catalog no longer holds).
//   PK-07 retargetCustomerPack: only a per-project sheet objectId is accepted; every declared key is
//         byte-identical; the result is branded (the installer's normalize is a no-op on it).
//   PK-08 buildProjectTargetBinding: the declared band joins the field map; without one the map is
//         exactly S1's (template ids only).
//   PK-09 SWITCH OFF: the create answers 404 DISABLED with no host call, no ledger read, no install.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { STOCK_PREP_AUDIT_ACTIONS, __internals: auditInternals } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const { createStockPreparationProjectTargetStore } = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
const { createStockPreparationPackInstallStore } = require(path.join(LIB, 'stock-preparation-pack-install-store.cjs'))
const {
  PROJECT_SHEETS_ENABLED_ENV,
  deriveProjectSheetObjectId,
  buildProjectTargetBinding,
} = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const {
  normalizeCustomerPack,
  retargetCustomerPack,
  isNormalizedCustomerPack,
} = require(path.join(LIB, 'stock-preparation-customer-pack.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))

// Synthetic, obviously-fake values only.
const TENANT = 'tenant-s2-pack'
const PROJECT = 'PRJ-S2-PACK'
const STAGING = `${TENANT}:integration-core`
const ENV_SHEET = 'sheet_env_s2_synthetic'
const ENV_OBJECT = 'plm_stock_preparation_sandbox_s2_env'
const SOURCE_SYSTEM_ID = 'plm_sql_source_s2'
const PACK_ID = 's2-synthetic-pack'
const PACK_VERSION = 3
const EXT_NOTE = 'ext_syntheticNote'
const EXT_FLAG = 'ext_syntheticFlag'
const TEMPLATE_FIELD_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id)

const PULLER = Object.freeze({ id: 'u_s2_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })

const CREATE_PATH = '/api/integration/stock-preparation/projects/:projectNo/target'
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function samplePack(overrides = {}) {
  return {
    packId: PACK_ID,
    packVersion: PACK_VERSION,
    label: 'S2 synthetic pack',
    targetObjectId: ENV_OBJECT,
    extensionFields: [
      { id: EXT_NOTE, label: 'Synthetic note', type: 'string', ownership: 'human_preserved' },
      { id: EXT_FLAG, label: 'Synthetic flag', type: 'boolean', ownership: 'human_preserved' },
    ],
    ...overrides,
  }
}

// ── substrate ──────────────────────────────────────────────────────────────────────────────────

/** One in-memory db for BOTH stores, table by table. */
function makeMemoryDb() {
  const tables = new Map()
  const calls = []
  const rowsOf = (table) => {
    if (!tables.has(table)) tables.set(table, [])
    return tables.get(table)
  }
  const matches = (row, where) => Object.entries(where || {}).every(([c, v]) => (row[c] === undefined ? null : row[c]) === (v === undefined ? null : v))
  const api = {
    tables,
    calls,
    rowsOf,
    async transaction(fn) {
      calls.push('transaction')
      return fn({ ...api, async advisoryXactLock(key) { calls.push(`advisoryXactLock:${key}`) } })
    },
    async selectOne(table, where) { calls.push(`selectOne:${table}`); return rowsOf(table).find((r) => matches(r, where)) || null },
    async select(table, { where, limit } = {}) {
      calls.push(`select:${table}`)
      const found = rowsOf(table).filter((r) => matches(r, where))
      return typeof limit === 'number' ? found.slice(0, limit) : found
    },
    async insertOne(table, row) {
      calls.push(`insertOne:${table}`)
      const rows = rowsOf(table)
      if (rows.some((r) => r.tenant_id === row.tenant_id && r.project_no === row.project_no)) {
        throw Object.assign(new Error('dup'), { code: '23505', constraint: 'uniq_integration_stock_prep_project_target_scope' })
      }
      const stored = { archived_at: null, created_at: new Date('2026-10-09T00:00:00Z'), ...row }
      rows.push(stored)
      return [stored]
    },
    async countRows(table, where) { calls.push(`countRows:${table}`); return rowsOf(table).filter((r) => matches(r, where)).length },
    async upsertOne(table, row, { conflictColumns = [], updateColumns = [] } = {}) {
      calls.push(`upsertOne:${table}`)
      const rows = rowsOf(table)
      const key = Object.fromEntries(conflictColumns.map((c) => [c, row[c]]))
      const existing = rows.find((r) => matches(r, key))
      const now = new Date('2026-10-09T01:00:00Z')
      if (existing) {
        for (const column of updateColumns) existing[column] = column === 'last_install_at' ? now : row[column]
        return [existing]
      }
      const stored = { ...row, last_install_at: now, created_at: now }
      rows.push(stored)
      return [stored]
    },
  }
  return api
}

/**
 * The host provisioning surface with REAL per-object field sets: `ensureObject` lands the template's
 * columns, `ensureMissingObjectFields` lands the pack's (ON CONFLICT DO NOTHING), and the DB-backed
 * reads answer from exactly what landed. `failFieldWrite` makes the additive write throw (PK-05).
 */
function makeProvisioning() {
  const calls = []
  const objects = new Map()
  const state = { failFieldWrite: false }
  const keyOf = (projectId, objectId) => `${projectId}/${objectId}`
  const sheetIdOf = (projectId, objectId) => `sheet_${projectId}_${objectId}`.replace(/[^A-Za-z0-9_]/g, '_')
  const fieldIdOf = (objectId, fieldId) => `fld_${objectId.slice(-8)}_${fieldId}`
  const api = {
    calls,
    objects,
    state,
    getObjectSheetId: (projectId, objectId) => sheetIdOf(projectId, objectId),
    getFieldId: (_projectId, objectId, fieldId) => fieldIdOf(objectId, fieldId),
    getObjectViewId: (_projectId, objectId, viewId) => `view_${objectId.slice(-8)}_${viewId}`,
    async findObjectSheet({ projectId, objectId }) {
      calls.push(['findObjectSheet', objectId])
      const object = objects.get(keyOf(projectId, objectId))
      return object ? { id: sheetIdOf(projectId, objectId), baseId: object.baseId, name: object.name, description: null } : null
    },
    async resolveFieldIds({ objectId, fieldIds }) {
      calls.push(['resolveFieldIds', objectId])
      return Object.fromEntries(fieldIds.map((id) => [id, fieldIdOf(objectId, id)]))
    },
    async resolveExistingObjectFieldIds({ projectId, objectId, fieldIds }) {
      calls.push(['resolveExistingObjectFieldIds', objectId, [...fieldIds]])
      const object = objects.get(keyOf(projectId, objectId))
      if (!object) return {}
      return Object.fromEntries(fieldIds.filter((id) => object.fields.has(id)).map((id) => [id, fieldIdOf(objectId, id)]))
    },
    async readObjectFieldsContent({ projectId, objectId, fieldIds }) {
      calls.push(['readObjectFieldsContent', objectId])
      const object = objects.get(keyOf(projectId, objectId))
      if (!object) return {}
      const out = {}
      for (const id of fieldIds) if (object.fields.has(id)) out[id] = clone(object.fields.get(id))
      return out
    },
    async ensureObject({ projectId, baseId, descriptor }) {
      calls.push(['ensureObject', descriptor.id])
      const fields = new Map()
      descriptor.fields.forEach((field, order) => fields.set(field.id, { name: field.name, type: field.type, property: clone(field.property || {}), order }))
      objects.set(keyOf(projectId, descriptor.id), { baseId: baseId ?? null, name: descriptor.name, fields })
      return {
        baseId: baseId ?? null,
        sheet: { id: sheetIdOf(projectId, descriptor.id), baseId: baseId ?? null, name: descriptor.name, description: null },
        fields: descriptor.fields.map((field, order) => ({ id: fieldIdOf(descriptor.id, field.id), sheetId: sheetIdOf(projectId, descriptor.id), name: field.name, type: field.type, property: {}, order })),
      }
    },
    async ensureMissingObjectFields({ projectId, objectId, fields }) {
      calls.push(['ensureMissingObjectFields', objectId, fields.map((field) => field.id)])
      if (state.failFieldWrite) throw Object.assign(new Error('host refused the column write'), { code: 'SYNTHETIC_HOST_REFUSAL' })
      const object = objects.get(keyOf(projectId, objectId))
      if (!object) throw new Error(`no object ${objectId}`)
      const added = []
      const skipped = []
      for (const field of fields) {
        if (object.fields.has(field.id)) { skipped.push(fieldIdOf(objectId, field.id)); continue }
        object.fields.set(field.id, { name: field.name, type: field.type, property: clone(field.property || {}), order: field.order ?? object.fields.size })
        added.push(fieldIdOf(objectId, field.id))
      }
      return { addedFieldIds: added, skippedExistingFieldIds: skipped }
    },
    async patchObjectFieldProperty({ projectId, objectId, fieldId, propertyPatch }) {
      calls.push(['patchObjectFieldProperty', objectId, fieldId])
      const object = objects.get(keyOf(projectId, objectId))
      const field = object && object.fields.get(fieldId)
      if (!field) throw new Error(`no field ${fieldId}`)
      field.property = { ...field.property, ...clone(propertyPatch) }
      return { id: fieldIdOf(objectId, fieldId), property: field.property }
    },
    async ensureObjectDefaultView({ objectId }) { calls.push(['ensureObjectDefaultView', objectId]); return { created: true, existingViewCount: 0 } },
    async ensureView({ projectId, sheetId, descriptor }) {
      calls.push(['ensureView', descriptor.id, descriptor.objectId])
      return { id: api.getObjectViewId(projectId, descriptor.objectId, descriptor.id), sheetId, name: descriptor.name, type: 'grid', filterInfo: {}, sortInfo: {}, groupInfo: {}, hiddenFieldIds: [], config: {} }
    },
    async ensureSystemBase({ baseId }) { calls.push(['ensureSystemBase', baseId]); return { baseId, created: true } },
    async isSheetOwnedByProject(sheetId, projectId) {
      calls.push(['isSheetOwnedByProject', sheetId, projectId])
      return [...objects.keys()].some((key) => key.startsWith(`${projectId}/`) && sheetIdOf(projectId, key.slice(projectId.length + 1)) === sheetId)
    },
    async findObjectView() { calls.push(['findObjectView']); return null },
  }
  return api
}

/** Seed the env object with the template + the pack's columns, as a deployment that installed it has. */
function seedEnvObject(provisioning) {
  const fields = new Map()
  TEMPLATE_FIELD_IDS.forEach((id, order) => fields.set(id, { name: id, type: 'string', property: {}, order }))
  fields.set(EXT_NOTE, { name: EXT_NOTE, type: 'string', property: {}, order: 1000 })
  fields.set(EXT_FLAG, { name: EXT_FLAG, type: 'boolean', property: {}, order: 1001 })
  provisioning.objects.set(`${STAGING}/${ENV_OBJECT}`, { baseId: null, name: 'env', fields })
}

function sourceData(projectNo = PROJECT) {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: projectNo, Parent_OBJ_ID: 'PATH-S2' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-S2' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-S2', path_id: 'PATH-S2' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-S2', part_id: 'PART-S2', quantity: '2' }],
    DN_PDM_PartLibraryInfo: [{ OBJ_ID: 'PART-S2', IdentityNo: 'SYN-0001', IdentityName: 'Synthetic part', Material: 'Synthetic', SysVer: 'V1' }],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
}

function makeSourceAdapter() {
  const data = sourceData()
  const calls = []
  return {
    calls,
    adapter: {
      async read(input = {}) {
        calls.push(clone(input))
        const rows = Array.isArray(data[input.object]) ? data[input.object] : []
        const found = rows.filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
        return { records: found.map(clone), nextCursor: null, done: true }
      },
    },
  }
}

function makeRecordsApi() {
  const rows = []
  const calls = []
  return {
    calls,
    async queryRecords(input = {}) { calls.push(['queryRecords', input.sheetId]); return rows.filter((row) => row.sheetId === input.sheetId).map(clone) },
    async createRecord(input = {}) { calls.push(['createRecord', input.sheetId]); const created = { id: `rec_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }; rows.push(created); return clone(created) },
    async patchRecord(input = {}) { calls.push(['patchRecord', input.sheetId]); return { id: input.recordId, sheetId: input.sheetId, version: 2, data: { ...(input.changes || {}) } } },
  }
}

function inertService(methods) {
  const service = {}
  for (const method of methods) service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
  return service
}

function baseServices(sourceAdapter) {
  const system = (input = {}) => ({
    id: input.id,
    tenantId: input.tenantId,
    name: 'Readonly PLM SQL (synthetic)',
    kind: 'data-source:sql-readonly',
    role: 'source',
    status: 'active',
    config: { dataSourceId: 'ds_s2_synthetic', object: 'DN_PDM_PathExAttrInfo' },
  })
  return {
    externalSystemRegistry: {
      ...inertService(['upsertExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
      async getExternalSystem(input = {}) { return system(input) },
      async getExternalSystemForAdapter(input = {}) { return { ...system(input), credentials: {} } },
    },
    adapterRegistry: { createAdapter() { return sourceAdapter }, listAdapterKinds() { return [] } },
    pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
  }
}

function mount({ switchOn = true, packs = { [PACK_ID]: samplePack() }, extensionFieldIds = [EXT_NOTE, EXT_FLAG], ledgerPackIds = [PACK_ID] } = {}) {
  const routes = new Map()
  const auditAppends = []
  const provisioning = makeProvisioning()
  seedEnvObject(provisioning)
  const records = makeRecordsApi()
  const source = makeSourceAdapter()
  const db = makeMemoryDb()
  const context = {
    api: {
      http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } },
      multitable: { provisioning, records },
    },
    storage: Object.assign(new Map(), { durable: true }),
    config: {
      stockPreparationTableActions: [{
        actionId: PLM_STOCK_PREPARATION_ACTION_ID,
        source: { externalSystemId: SOURCE_SYSTEM_ID, kind: 'data-source:sql-readonly' },
        target: { sheetId: ENV_SHEET, objectId: ENV_OBJECT, fieldIdMap: {} },
        ...(extensionFieldIds.length ? { extensionFieldIds } : {}),
      }],
      stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [ENV_OBJECT] },
      stockPreparationCustomerPacks: packs,
    },
  }
  const services = baseServices(source.adapter)
  services.stockPreparationAuditStore = {
    async append(entry) {
      auditInternals.assertValuesFreeDetail(entry.detail)
      assert.ok(STOCK_PREP_AUDIT_ACTIONS.includes(entry.action), `audit action ${entry.action} is in the closed vocabulary`)
      auditAppends.push(entry)
      return { ok: true }
    },
    async supportsAction() { return { supported: true, reason: 'check_constraint_accepts' } },
    async list() { return { rowCount: 0, entries: [] } },
  }
  let n = 0
  services.stockPreparationProjectTargetStore = createStockPreparationProjectTargetStore({ db, idGenerator: () => `pt-${(n += 1)}` })
  const packInstalls = createStockPreparationPackInstallStore({ db, idGenerator: () => `pi-${(n += 1)}` })
  services.stockPreparationPackInstallStore = packInstalls
  services.tenantPrincipalDirectory = { async verifyTenantMembership() { return { member: true } } }
  // The deployment's own install of the pack on its ENV object — the ledger row S2 reads.
  for (const packId of ledgerPackIds) {
    db.rowsOf('integration_stock_prep_pack_installs').push({
      id: `seed-${packId}`, tenant_id: TENANT, workspace_id: null, project_id: STAGING, object_id: ENV_OBJECT,
      pack_id: packId, pack_version: PACK_VERSION, mode: 'install', status: 'installed',
      installed_fields_json: [], summary_json: {}, warnings_json: [], last_install_at: new Date('2026-10-01T00:00:00Z'),
    })
  }
  const previous = {}
  for (const key of [PROJECT_SHEETS_ENABLED_ENV, 'MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS', 'MULTITABLE_STOCK_PREP_OWN_BASE']) {
    previous[key] = process.env[key]
    delete process.env[key]
  }
  if (switchOn) process.env[PROJECT_SHEETS_ENABLED_ENV] = 'true'
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
  return {
    routes, auditAppends, provisioning, records, source, db, context, packInstalls,
    projectObjectId: deriveProjectSheetObjectId(TENANT, PROJECT),
    restore() { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } },
  }
}

function createResponse() {
  return {
    statusCode: 200, body: undefined, headers: {},
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    setHeader(name, value) { this.headers[name] = value; return this },
    send(payload) { this.sentBuffer = payload; return this },
  }
}

async function call(routes, method, routePath, req = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  return res
}

const createTarget = (h) => call(h.routes, 'POST', CREATE_PATH, { user: PULLER, params: { projectNo: PROJECT }, body: {} })
const dryRun = (h) => call(h.routes, 'POST', DRY_RUN_PATH, { user: PULLER, params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, body: { parameters: { projectNo: PROJECT } }, query: { tenantId: TENANT } })

const registryRows = (h) => h.db.rowsOf('integration_stock_prep_project_target')
const ledgerRowsOn = (h, objectId) => h.db.rowsOf('integration_stock_prep_pack_installs').filter((row) => row.object_id === objectId)
const installerHostCalls = (h) => h.provisioning.calls.filter((c) => ['ensureMissingObjectFields', 'patchObjectFieldProperty', 'readObjectFieldsContent'].includes(c[0]))

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('PK-01 create: the pack lands on the PROJECT object, the ledger records it there, the row is registered AFTER the install, audited values-free', async () => {
  const h = mount()
  try {
    const res = await createTarget(h)
    assert.equal(res.statusCode, 201, JSON.stringify(res.body))
    const objectId = h.projectObjectId
    const writes = h.provisioning.calls.filter((c) => c[0] === 'ensureMissingObjectFields')
    assert.deepEqual(writes, [['ensureMissingObjectFields', objectId, [EXT_NOTE, EXT_FLAG]]], 'one additive write, on the project object, of exactly the pack columns')
    assert.ok(!h.provisioning.calls.some((c) => c[1] === ENV_OBJECT && c[0] !== 'findObjectSheet'), 'the env object is never written')
    const projectObject = h.provisioning.objects.get(`${STAGING}/${objectId}`)
    assert.ok(projectObject.fields.has(EXT_NOTE) && projectObject.fields.has(EXT_FLAG), 'the project sheet now carries the ext columns')
    const ledger = ledgerRowsOn(h, objectId)
    assert.equal(ledger.length, 1, 'the install ledger records the pack ON THE PROJECT OBJECT')
    assert.equal(ledger[0].pack_id, PACK_ID)
    assert.equal(ledger[0].pack_version, String(PACK_VERSION), 'the ledger stores the version as TEXT (migration 076)')
    assert.equal(ledger[0].status, 'installed')
    assert.equal(ledger[0].project_id, STAGING, 'under the caller\'s own staging project')
    // ORDER: the ledger row (the installer's LAST write) precedes the registry insert.
    const ledgerAt = h.db.calls.indexOf('upsertOne:integration_stock_prep_pack_installs')
    const registryAt = h.db.calls.indexOf('insertOne:integration_stock_prep_project_target')
    assert.ok(ledgerAt !== -1 && registryAt !== -1 && ledgerAt < registryAt, `install BEFORE register (${ledgerAt} < ${registryAt})`)
    assert.equal(registryRows(h).length, 1)
    assert.deepEqual(res.body.data.customerPacks, { planned: 1, installed: 1, alreadyInstalled: 0, notInCatalog: 0 })
    assert.deepEqual(h.auditAppends.map((e) => [e.action, e.mode]), [
      ['project_target_create', 'sheet_created'],
      ['project_target_create', 'customer_pack_installed'],
    ])
    assert.deepEqual(h.auditAppends[1].detail, {
      installedPackCount: 1,
      alreadyInstalledPackCount: 0,
      notInCatalogPackCount: 0,
      declaredExtensionFieldCount: 2,
      createdFieldCount: 2,
      stampedFieldCount: 0,
      packVersions: { [PACK_ID]: PACK_VERSION },
    })
    assert.equal(h.auditAppends[1].projectId, PROJECT)
  } finally { h.restore() }
})

test('PK-02 the first dry-run on the new sheet is 200 ready — no 422 — and the existence probe judged the ext columns on the project object', async () => {
  const h = mount()
  try {
    assert.equal((await createTarget(h)).statusCode, 201)
    const res = await dryRun(h)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.status, 'ready')
    const probes = h.provisioning.calls.filter((c) => c[0] === 'resolveExistingObjectFieldIds' && c[1] === h.projectObjectId)
    assert.ok(probes.length >= 1, 'the DB-backed probe ran on the project object')
    assert.ok(probes.some((c) => c[2].includes(EXT_NOTE) && c[2].includes(EXT_FLAG)), 'and asked about the declared ext columns')
    assert.ok(h.source.calls.length > 0, 'the plan really read the source (it got past both schema gates)')
  } finally { h.restore() }
})

test('PK-03 a sheet registered WITHOUT its pack answers the dry-run 422; the 200 replay heals it and the next dry-run is 200', async () => {
  const h = mount()
  try {
    // S1's limitation, reproduced: the sheet is provisioned and registered, its pack never landed.
    const objectId = h.projectObjectId
    const fields = new Map()
    TEMPLATE_FIELD_IDS.forEach((id, order) => fields.set(id, { name: id, type: 'string', property: {}, order }))
    h.provisioning.objects.set(`${STAGING}/${objectId}`, { baseId: null, name: 'project', fields })
    const sheetId = h.provisioning.getObjectSheetId(STAGING, objectId)
    registryRows(h).push({ id: 'seed-s1', tenant_id: TENANT, project_no: PROJECT, sheet_id: sheetId, object_id: objectId, status: 'active', created_by: 'seed', created_at: new Date('2026-10-08T00:00:00Z'), archived_at: null })

    const before = await dryRun(h)
    assert.equal(before.statusCode, 422, JSON.stringify(before.body))
    assert.equal(before.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
    assert.deepEqual([...before.body.error.details.missingFields].sort(), [EXT_FLAG, EXT_NOTE].sort(), 'exactly the pack columns are missing')
    assert.deepEqual(h.source.calls, [], 'refused before any source read')

    const healed = await createTarget(h)
    assert.equal(healed.statusCode, 200, JSON.stringify(healed.body))
    assert.equal(healed.body.data.created, false)
    assert.deepEqual(healed.body.data.customerPacks, { planned: 1, installed: 1, alreadyInstalled: 0, notInCatalog: 0 })
    assert.deepEqual(h.auditAppends.map((e) => [e.action, e.mode]), [['project_target_create', 'customer_pack_installed']], 'the heal is audited; no second create row')
    assert.equal(registryRows(h).length, 1, 'no second registry row')

    const after = await dryRun(h)
    assert.equal(after.statusCode, 200, JSON.stringify(after.body))
    assert.equal(after.body.data.status, 'ready')
  } finally { h.restore() }
})

test('PK-04 idempotent replay: a pack already live on the project object is never re-run — no installer host call, no audit row', async () => {
  const h = mount()
  try {
    assert.equal((await createTarget(h)).statusCode, 201)
    h.provisioning.calls.length = 0
    const auditsBefore = h.auditAppends.length
    const again = await createTarget(h)
    assert.equal(again.statusCode, 200, JSON.stringify(again.body))
    assert.deepEqual(again.body.data.customerPacks, { planned: 1, installed: 0, alreadyInstalled: 1, notInCatalog: 0 })
    assert.deepEqual(installerHostCalls(h), [], 'the installer made no host call on the replay')
    assert.deepEqual(h.auditAppends.slice(auditsBefore), [], 'nothing landed, so nothing is audited (no grant configured either)')
    assert.equal(ledgerRowsOn(h, h.projectObjectId).length, 1, 'still one ledger row')
    assert.equal(registryRows(h).length, 1)
  } finally { h.restore() }
})

test('PK-05 a failed install leaves NO registered row; the same POST registers once the host recovers', async () => {
  const h = mount()
  try {
    h.provisioning.state.failFieldWrite = true
    const failed = await createTarget(h)
    assert.notEqual(failed.statusCode, 200)
    assert.notEqual(failed.statusCode, 201)
    assert.equal(failed.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_PACK_INSTALL_FAILED', JSON.stringify(failed.body))
    assert.deepEqual({ ...failed.body.error.details }, { packId: PACK_ID, installCode: 'CUSTOMER_PACK_FIELD_WRITE_FAILED' })
    assert.equal(registryRows(h).length, 0, 'NO registry row points at a sheet without its pack')
    assert.ok(!h.db.calls.includes('insertOne:integration_stock_prep_project_target'), 'the registry insert was never attempted')
    assert.deepEqual(ledgerRowsOn(h, h.projectObjectId), [], 'no ledger row for an install that did not finish')
    assert.deepEqual(h.auditAppends, [], 'no audit row')
    assert.ok(!JSON.stringify(failed.body).includes('host refused'), 'the host message never reaches the response')

    h.provisioning.state.failFieldWrite = false
    const retried = await createTarget(h)
    assert.equal(retried.statusCode, 201, JSON.stringify(retried.body))
    assert.equal(registryRows(h).length, 1)
    assert.equal(h.provisioning.calls.filter((c) => c[0] === 'ensureObject').length, 1, 'the sheet provisioned by the failed attempt is reused (idempotent ensure), not created twice')
    assert.deepEqual(retried.body.data.customerPacks, { planned: 1, installed: 1, alreadyInstalled: 0, notInCatalog: 0 })
  } finally { h.restore() }
})

test('PK-06 a declared band no pack can cover is refused 409 PACK_INCOMPLETE before anything is provisioned', async () => {
  for (const [label, options] of [
    ['no ledger row on the env object', { ledgerPackIds: [] }],
    ['the ledger pack is no longer in this server\'s catalog', { packs: {} }],
  ]) {
    const h = mount(options)
    try {
      const res = await createTarget(h)
      assert.equal(res.statusCode, 409, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_PACK_INCOMPLETE', label)
      assert.deepEqual([...res.body.error.details.missingExtensionFields].sort(), [EXT_FLAG, EXT_NOTE].sort(), label)
      assert.ok(!h.provisioning.calls.some((c) => c[0] === 'ensureObject'), `${label}: nothing provisioned`)
      assert.equal(registryRows(h).length, 0, label)
      assert.deepEqual(h.auditAppends, [], label)
    } finally { h.restore() }
  }
  // CONTROL: a deployment that declares no band and carries no pack creates exactly as S1 did.
  const bare = mount({ extensionFieldIds: [], ledgerPackIds: [], packs: {} })
  try {
    const res = await createTarget(bare)
    assert.equal(res.statusCode, 201, JSON.stringify(res.body))
    assert.deepEqual(res.body.data.customerPacks, { planned: 0, installed: 0, alreadyInstalled: 0, notInCatalog: 0 })
    assert.deepEqual(installerHostCalls(bare), [], 'no installer call at all')
  } finally { bare.restore() }
})

test('PK-07 retargetCustomerPack: per-project sheets only, every declared key byte-identical, branded', () => {
  const projectObjectId = deriveProjectSheetObjectId(TENANT, PROJECT)
  const source = normalizeCustomerPack(samplePack())
  const moved = retargetCustomerPack(source, projectObjectId)
  assert.ok(isNormalizedCustomerPack(moved), 'branded: the installer\'s own normalize is a no-op on it')
  assert.equal(normalizeCustomerPack(moved), moved)
  assert.equal(moved.targetObjectId, projectObjectId)
  const { targetObjectId: _a, ...restMoved } = moved
  const { targetObjectId: _b, ...restSource } = source
  assert.deepEqual(clone(restMoved), clone(restSource), 'every other key is the source pack\'s')
  assert.deepEqual(Object.keys(moved), Object.keys(source), 'same key order')
  assert.equal(source.targetObjectId, ENV_OBJECT, 'the source pack is untouched')
  for (const [label, objectId] of [
    ['the canonical main table', STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId],
    ['a hand-named sandbox object', ENV_OBJECT],
    ['an absent value', undefined],
    ['a malformed project-sheet id', 'plm_stock_preparation_sandbox_p_NOTHEX'],
  ]) {
    assert.throws(() => retargetCustomerPack(source, objectId), (error) => error.reason === 'PACK_TARGET_OBJECT_ID_INVALID', label)
  }
})

test('PK-08 buildProjectTargetBinding: the declared band joins the map; without one the map is S1\'s', async () => {
  const provisioning = makeProvisioning()
  const target = { sheetId: 'sheet_x', objectId: deriveProjectSheetObjectId(TENANT, PROJECT) }
  const bare = await buildProjectTargetBinding({ provisioning, projectId: STAGING, target })
  assert.deepEqual(Object.keys(bare.fieldIdMap), TEMPLATE_FIELD_IDS, 'S1 shape: template ids only')
  const withBand = await buildProjectTargetBinding({ provisioning, projectId: STAGING, target, extensionFieldIds: [EXT_NOTE, EXT_FLAG, EXT_NOTE, 7] })
  assert.deepEqual(Object.keys(withBand.fieldIdMap), [...TEMPLATE_FIELD_IDS, EXT_NOTE, EXT_FLAG], 'template ids, then the band (deduplicated, strings only)')
  assert.equal(withBand.fieldIdMap[EXT_NOTE], provisioning.getFieldId(STAGING, target.objectId, EXT_NOTE))
})

test('PK-09 switch OFF: the create answers 404 DISABLED with no host call, no ledger read and no install', async () => {
  const h = mount({ switchOn: false })
  try {
    const res = await createTarget(h)
    assert.equal(res.statusCode, 404)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED')
    assert.deepEqual(h.provisioning.calls, [])
    assert.deepEqual(h.db.calls, [])
  } finally { h.restore() }
})

;(async () => {
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log(`  ${name} OK`)
    } catch (error) {
      failed += 1
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    }
  }
  if (failed) {
    console.error(`stock-preparation-project-target-pack-reinstall.test.cjs FAILED (${failed})`)
    process.exit(1)
  }
  console.log('✓ stock-preparation-project-target-pack-reinstall')
})()
