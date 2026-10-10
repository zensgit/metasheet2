'use strict'

// 一个项目一张备料表 — ONE in-memory substrate for the project-sheet route suites (S2, R-36).
//
// Shared by `stock-preparation-project-target-pack-reinstall.test.cjs` and the permission matrix's
// switch-ON pass, so "the create passes for a puller" is measured against routes that really
// provision, register and grant — not against the 404 the switch-off harness answers.
//
// What is REAL: the route stack (`registerIntegrationRoutes`), the project-target store and the
// pack-install store (over one memory db), the customer-pack catalog built from server config, the
// installer, and the field-permission invariant (`support/stock-preparation-write-scope-port.cjs`).
// What is FAKE: the host provisioning (but with real per-object field sets, so the DB-backed
// field-existence probe judges what the installer actually landed), the records API, the PLM source
// adapter, the audit store and the tenant directory. Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { STOCK_PREP_AUDIT_ACTIONS, __internals: auditInternals } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const { createStockPreparationProjectTargetStore } = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
const { createStockPreparationPackInstallStore } = require(path.join(LIB, 'stock-preparation-pack-install-store.cjs'))
const {
  PROJECT_SHEETS_ENABLED_ENV,
  PROJECT_SHEET_GRANT_ROLE_IDS_ENV,
  deriveProjectSheetObjectId,
} = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const TEMPLATE_FIELD_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id)
const PROJECT_TARGET_TABLE = 'integration_stock_prep_project_target'
const PACK_INSTALL_TABLE = 'integration_stock_prep_pack_installs'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** One in-memory db for BOTH stores, table by table. */
function makeMemoryDb() {
  const tables = new Map()
  const calls = []
  // S4 fix round 1: the advisory lock is a REAL per-key FIFO mutex here, released when the
  // transaction's callback settles — so a suite can force the interleaving a missing (or released
  // too early) lock would allow, instead of a lock that only records that it was asked for.
  const lockTails = new Map()
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
      const releases = []
      const trx = {
        ...api,
        async advisoryXactLock(key) {
          calls.push(`advisoryXactLock:${key}`)
          const previous = lockTails.get(key) || Promise.resolve()
          let release
          const held = new Promise((resolve) => { release = resolve })
          lockTails.set(key, previous.then(() => held))
          await previous
          releases.push(release)
        },
      }
      try {
        return await fn(trx)
      } finally {
        for (const release of releases) release()
      }
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
    // S4: the lifecycle transitions read the row FOR UPDATE and write with a compare-and-set where.
    async selectOneForUpdate(table, where) { calls.push(`selectOneForUpdate:${table}`); return rowsOf(table).find((r) => matches(r, where)) || null },
    async updateRow(table, set, where) {
      calls.push(`updateRow:${table}`)
      const hit = rowsOf(table).filter((r) => matches(r, where))
      for (const row of hit) Object.assign(row, set)
      return hit.map((row) => ({ ...row }))
    },
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
 * columns, `ensureMissingObjectFields` lands a pack's (ON CONFLICT DO NOTHING), `patchObjectFieldProperty`
 * merges, and the DB-backed reads answer from exactly what landed. `state.failFieldWrite` makes the
 * additive write throw (a genuine mid-install host failure).
 */
function makeProvisioning({ stampsSystemKind = false } = {}) {
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
    sheetIdOf,
    // S3 fix round 1 (R8c): the host's declaration that it stamps `systemKind` at INSERT. OPT-IN here — a
    // mount without it is an OLDER host, on which the overview legs refuse before any IO, so every suite
    // that predates the overview sees exactly the host calls and audit rows it always saw.
    ...(stampsSystemKind ? { supportsSystemKindStamp: true } : {}),
    getObjectSheetId: (projectId, objectId) => sheetIdOf(projectId, objectId),
    getFieldId: (_projectId, objectId, fieldId) => fieldIdOf(objectId, fieldId),
    getObjectViewId: (_projectId, objectId, viewId) => `view_${objectId.slice(-8)}_${viewId}`,
    async findObjectSheet({ projectId, objectId }) {
      calls.push(['findObjectSheet', objectId])
      const object = objects.get(keyOf(projectId, objectId))
      // S3: the host reports the server-owned `system_kind` it stamped at provisioning (null otherwise).
      return object ? { id: sheetIdOf(projectId, objectId), baseId: object.baseId, name: object.name, description: null, systemKind: object.systemKind ?? null } : null
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
    async ensureObject({ projectId, baseId, descriptor, systemKind }) {
      calls.push(['ensureObject', descriptor.id])
      const fields = new Map()
      descriptor.fields.forEach((field, order) => fields.set(field.id, { name: field.name, type: field.type, property: clone(field.property || {}), order }))
      // S3: the host-owned stamp, stored on INSERT only (an existing object keeps whatever it had)
      // and reported back on the sheet — exactly what the real host does (provisioning.ts).
      const existing = objects.get(keyOf(projectId, descriptor.id))
      const stamped = existing ? (existing.systemKind ?? null) : (typeof systemKind === 'string' && systemKind ? systemKind : null)
      objects.set(keyOf(projectId, descriptor.id), { baseId: baseId ?? null, name: descriptor.name, fields, systemKind: stamped })
      return {
        baseId: baseId ?? null,
        sheet: { id: sheetIdOf(projectId, descriptor.id), baseId: baseId ?? null, name: descriptor.name, description: null, systemKind: stamped },
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
      calls.push(['ensureView', descriptor.id, descriptor.objectId, sheetId])
      return { id: api.getObjectViewId(projectId, descriptor.objectId, descriptor.id), sheetId, name: descriptor.name, type: 'grid', filterInfo: {}, sortInfo: {}, groupInfo: {}, hiddenFieldIds: [], config: {} }
    },
    async ensureSystemBase({ baseId }) { calls.push(['ensureSystemBase', baseId]); return { baseId, created: true } },
    async isSheetOwnedByProject(sheetId, projectId) {
      calls.push(['isSheetOwnedByProject', sheetId, projectId])
      return [...objects.keys()].some((key) => key.startsWith(`${projectId}/`) && sheetIdOf(projectId, key.slice(projectId.length + 1)) === sheetId)
    },
    async findObjectView() { calls.push(['findObjectView']); return null },
    grantCalls: [],
    async grantSheetRoleWrite(input) {
      calls.push(['grantSheetRoleWrite', input.sheetId])
      api.grantCalls.push(input)
      return { sheetId: input.sheetId, granted: api.grantCalls.length === 1 ? [...input.roleIds] : [], alreadyGranted: api.grantCalls.length === 1 ? [] : [...input.roleIds] }
    },
    // S3 fix round 1 (R1): the overview's G1 READ port — add-only, idempotent per (sheet, role).
    overviewGrantCalls: [],
    overviewReadGrants: new Set(),
    async grantOverviewRoleRead(input) {
      calls.push(['grantOverviewRoleRead', input.sheetId])
      api.overviewGrantCalls.push(input)
      const granted = []
      const alreadyGranted = []
      for (const roleId of input.roleIds) {
        const key = `${input.sheetId}::${roleId}`
        if (api.overviewReadGrants.has(key)) alreadyGranted.push(roleId)
        else { api.overviewReadGrants.add(key); granted.push(roleId) }
      }
      return { sheetId: input.sheetId, granted, alreadyGranted }
    },
  }
  return api
}

/** Seed an object with the template's columns plus `extraFieldIds`, as a host that already has it. */
function seedObject(provisioning, projectId, objectId, extraFieldIds = []) {
  const fields = new Map()
  TEMPLATE_FIELD_IDS.forEach((id, order) => fields.set(id, { name: id, type: 'string', property: {}, order }))
  extraFieldIds.forEach((id, index) => fields.set(id, { name: id, type: 'string', property: {}, order: 1000 + index }))
  provisioning.objects.set(`${projectId}/${objectId}`, { baseId: null, name: 'seeded', fields })
}

function sourceData(projectNo) {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: projectNo, Parent_OBJ_ID: 'PATH-SYN' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-SYN' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-SYN', path_id: 'PATH-SYN' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-SYN', part_id: 'PART-SYN', quantity: '2' }],
    DN_PDM_PartLibraryInfo: [{ OBJ_ID: 'PART-SYN', IdentityNo: 'SYN-0001', IdentityName: 'Synthetic part', Material: 'Synthetic', SysVer: 'V1' }],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
}

function makeSourceAdapter(projectNo) {
  const data = sourceData(projectNo)
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
    // S3 fix round 1 (R3): the plugin SDK delete the overview uses to remove duplicate / orphan rows.
    async deleteRecord(input = {}) {
      calls.push(['deleteRecord', input.sheetId])
      const index = rows.findIndex((row) => row.id === input.recordId && row.sheetId === input.sheetId)
      if (index >= 0) rows.splice(index, 1)
      return { id: input.recordId, sheetId: input.sheetId, version: 1 }
    },
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
    config: { dataSourceId: 'ds_synthetic', object: 'DN_PDM_PathExAttrInfo' },
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

/**
 * Mount the real route stack over the substrate. Options:
 *   tenantId / projectNo — the synthetic scope the source adapter answers for;
 *   switchOn             — MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED === 'true' for this mount;
 *   grantRoleIds         — the G1 env role list (unset = G2, no grant call);
 *   envObjectId          — the deployment's env target object (seeded with template + `envExtFieldIds`);
 *   extensionFieldIds    — the action's declared ext band;
 *   packs                — the server catalog (`stockPreparationCustomerPacks`);
 *   ledger               — [{ packId, packVersion, objectId?, status? }] seeded install-ledger rows;
 *   fieldPermissions     — the host's field-permission port (or null: no port);
 *   sourceBindingStore   — optional `stockPreparationSourceBindingStore` (a throwing one models an
 *                          unreachable binding table behind the deployment lookup);
 *   configExtras / serviceExtras — S4: merged into the plugin config / the services (a handoff
 *                          chain and store, a reconcile lease, an xlsx exporter) so the §6 route
 *                          table can drive every route on one substrate.
 */
function mountProjectSheetRoutes({
  tenantId,
  projectNo,
  switchOn = true,
  // S3 fix round 1: a host that declares the overview stamp (see makeProvisioning). Off = an older host.
  stampsSystemKind = false,
  // S3 fix round 1: the route logger (default: silent) — a suite that pins a values-free warn passes its own.
  logger = { info() {}, warn() {}, error() {} },
  grantRoleIds = null,
  envObjectId,
  envExtFieldIds = [],
  extensionFieldIds = [],
  packs = {},
  ledger = [],
  fieldPermissions = null,
  sourceBindingStore = null,
  configExtras = {},
  serviceExtras = {},
} = {}) {
  const staging = `${tenantId}:integration-core`
  const routes = new Map()
  const auditAppends = []
  const provisioning = makeProvisioning({ stampsSystemKind })
  if (envObjectId) seedObject(provisioning, staging, envObjectId, envExtFieldIds)
  const records = makeRecordsApi()
  const source = makeSourceAdapter(projectNo)
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
        source: { externalSystemId: 'plm_sql_source_synthetic', kind: 'data-source:sql-readonly' },
        target: { sheetId: 'sheet_env_synthetic', objectId: envObjectId || 'plm_stock_preparation_sandbox_synthetic_env', fieldIdMap: {} },
        ...(extensionFieldIds.length ? { extensionFieldIds } : {}),
      }],
      stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [envObjectId || 'plm_stock_preparation_sandbox_synthetic_env'] },
      stockPreparationCustomerPacks: packs,
      ...configExtras,
    },
  }
  const services = Object.assign(baseServices(source.adapter), serviceExtras)
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
  services.stockPreparationPackInstallStore = createStockPreparationPackInstallStore({ db, idGenerator: () => `pi-${(n += 1)}` })
  services.tenantPrincipalDirectory = { async verifyTenantMembership() { return { member: true } } }
  if (fieldPermissions) services.stockPreparationFieldPermissions = fieldPermissions
  if (sourceBindingStore) services.stockPreparationSourceBindingStore = sourceBindingStore
  for (const entry of ledger) {
    db.rowsOf(PACK_INSTALL_TABLE).push({
      id: `seed-${entry.packId}-${entry.objectId || envObjectId}`, tenant_id: tenantId, workspace_id: null, project_id: staging,
      object_id: entry.objectId || envObjectId, pack_id: entry.packId, pack_version: String(entry.packVersion), mode: 'install',
      status: entry.status || 'installed', installed_fields_json: [], summary_json: {}, warnings_json: [],
      last_install_at: new Date('2026-10-01T00:00:00Z'),
    })
  }
  const previous = {}
  for (const key of [PROJECT_SHEETS_ENABLED_ENV, PROJECT_SHEET_GRANT_ROLE_IDS_ENV, 'MULTITABLE_STOCK_PREP_OWN_BASE']) {
    previous[key] = process.env[key]
    delete process.env[key]
  }
  if (switchOn) process.env[PROJECT_SHEETS_ENABLED_ENV] = 'true'
  if (grantRoleIds) process.env[PROJECT_SHEET_GRANT_ROLE_IDS_ENV] = grantRoleIds.join(',')
  httpRoutes.registerIntegrationRoutes({ context, services, logger })
  return {
    routes, auditAppends, provisioning, records, source, db, context, staging,
    // S3 fix round 1: the REAL registry store the routes use, for suites that drive the overview module directly.
    projectTargetStore: services.stockPreparationProjectTargetStore,
    projectObjectId: (no = projectNo) => deriveProjectSheetObjectId(tenantId, no),
    registryRows: () => db.rowsOf(PROJECT_TARGET_TABLE),
    /**
     * S4: register `no` directly (no route, no audit) — its sheet provisioned on the fake host with
     * the template's columns, the row active or archived (`archived_at` set iff archived, as 087's
     * CHECK requires). Clears the host call log so a test sees only what IT caused.
     */
    seedRegistryRow(no = projectNo, { archived = false, tenant = tenantId } = {}) {
      const projectIdFor = `${tenant}:integration-core`
      const objectId = deriveProjectSheetObjectId(tenant, no)
      seedObject(provisioning, projectIdFor, objectId)
      const sheetId = provisioning.sheetIdOf(projectIdFor, objectId)
      db.rowsOf(PROJECT_TARGET_TABLE).push({
        id: `seed-${tenant}-${no}`, tenant_id: tenant, project_no: no, sheet_id: sheetId, object_id: objectId,
        status: archived ? 'archived' : 'active', created_by: 'seed', created_at: new Date('2026-10-08T00:00:00Z'),
        archived_at: archived ? new Date('2026-10-09T00:00:00Z') : null, archived_by: archived ? 'seed' : null,
        restored_at: null, restored_by: null, updated_at: new Date('2026-10-08T00:00:00Z'),
      })
      provisioning.calls.length = 0
      db.calls.length = 0
      return { sheetId, objectId }
    },
    ledgerRowsOn: (objectId) => db.rowsOf(PACK_INSTALL_TABLE).filter((row) => row.object_id === objectId),
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
  const request = { user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }
  if (req.authenticatedTenantId !== undefined) request.authenticatedTenantId = req.authenticatedTenantId
  await handler(request, res)
  return res
}

module.exports = {
  TEMPLATE_FIELD_IDS,
  PROJECT_TARGET_TABLE,
  PACK_INSTALL_TABLE,
  clone,
  makeMemoryDb,
  makeProvisioning,
  seedObject,
  mountProjectSheetRoutes,
  call,
}
