'use strict'

// CUSTOMER-PACK HTTP SURFACE — the entry point that makes the pack line executable.
//
// Before this, installCustomerPack was reachable only from `node __tests__/…`. The four routes here
// are the whole executable surface, and they share ONE authorization posture, which is what this
// suite is mostly about:
//
//   1. ADMIN GATE on every route (requireAccess 'admin'), mirroring plugin-after-sales'
//      hasInstallAdminAccess. A write-tier user is not enough.
//   2. SERVER-HELD PACK ALLOWLIST, mirroring after-sales' ALLOWED_TEMPLATE_IDS. The request carries
//      a packId, never a pack: a request-supplied pack would turn an admin session into schema
//      authoring on the canonical sheet (arbitrary `ext_` columns with arbitrary ownership bands).
//      An unlisted id is refused BEFORE any host call.
//   3. AUTH-DERIVED TENANT/PROJECT. No request field can steer the install at another sheet.
//   4. DRY RUN = ZERO WRITES, asserted against a fake that records EVERY provisioning call, not
//      merely the ones we remembered to look for.
//   5. VALUES-FREE responses.
//   6. THE HOST FIELD-PERMISSION PORT IS ACTUALLY WIRED. A pack that declares fieldWritePolicies
//      must reach `services.stockPreparationFieldPermissions` THROUGH the route, with the physical
//      (fieldId, roleId) rows and nothing else; and a declared policy with NO port must be a coded
//      503 that leaves the sheet untouched.
//
// Hermetic: no DB, no network. The service stubs below are inert on purpose — any route that
// touched one would fail loudly rather than pass silently.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { createStockPreparationPackInstallStore } = require(path.join(LIB, 'stock-preparation-pack-install-store.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const TENANT_ID = 'tenant-a'
const PROJECT_ID = `${TENANT_ID}:integration-core`
const OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId

const PACK_ID = 'routes-pack'
const EXT_PLM = 'ext_legacyRowId'
const EXT_HUMAN = 'ext_blankLength'

const SUITE_PACK = Object.freeze({
  packId: PACK_ID,
  packVersion: 1,
  label: 'routes suite pack',
  extensionFields: [
    { id: EXT_PLM, label: '旧系统ID', type: 'string', ownership: 'plm_system' },
    { id: EXT_HUMAN, label: '毛胚长度', type: 'number', ownership: 'human_preserved' },
  ],
  optionSets: [],
  roleViews: [
    { viewId: 'production', label: '生产备料视图', hideOwnerships: ['human_preserved'], hideFieldIds: ['path'] },
  ],
})

// Tenant-BOUND admin: the write routes derive the project from the authenticated tenant, so a
// tenantless platform admin has no sheet to install onto and is refused before anything else.
const ADMIN = Object.freeze({ id: 'u_admin', roles: ['admin'], tenantId: TENANT_ID })
const WRITER = Object.freeze({ id: 'u_writer', permissions: ['integration:write'], tenantId: TENANT_ID })
const READER = Object.freeze({ id: 'u_reader', permissions: ['integration:read'], tenantId: TENANT_ID })

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

// The provisioning surface, recording EVERY call by name. The zero-writes assertion is stated as
// "no call outside the read set" rather than "these specific writes did not happen", so a future
// write primitive is caught by default instead of needing to be remembered.
const WRITE_METHODS = Object.freeze(['ensureMissingObjectFields', 'patchObjectFieldProperty', 'ensureView', 'ensureObject'])

function physicalFieldId(projectId, objectId, fieldId) {
  return `fld_${projectId}_${objectId}_${fieldId}`
}

function createFakeProvisioning({ sheetMissing = false, seedConflict = false, seedUnstamped = false } = {}) {
  const calls = []
  const fields = new Map()
  if (seedUnstamped) {
    // The TAKEOVER shape: the column was hand-built in the UI and carries no ownership stanza, so a
    // real install would PATCH it. A dry-run over the same sheet must still write nothing — this is
    // the case that actually exercises the stamp path, which an all-fresh sheet never reaches.
    fields.set(EXT_HUMAN, { name: EXT_HUMAN, type: 'number', property: {}, order: 5 })
  }
  if (seedConflict) {
    // A hand-built column that disagrees with the pack: the dry-run must REPORT it, not throw.
    fields.set(EXT_HUMAN, {
      name: EXT_HUMAN,
      type: 'number',
      property: { stockPreparation: { ownership: 'plm_system', preserveOnRefresh: false } },
      order: 5,
    })
  }
  return {
    calls,
    fields,
    async findObjectSheet({ objectId }) {
      calls.push('findObjectSheet')
      if (sheetMissing) return null
      return { id: `sheet_${objectId}`, baseId: null, name: objectId, description: null }
    },
    getFieldId(projectId, objectId, fieldId) {
      calls.push('getFieldId')
      return physicalFieldId(projectId, objectId, fieldId)
    },
    async readObjectFieldsContent({ fieldIds }) {
      calls.push('readObjectFieldsContent')
      const out = {}
      for (const fieldId of fieldIds) {
        if (fields.has(fieldId)) out[fieldId] = fields.get(fieldId)
      }
      return out
    },
    async resolveFieldIds() {
      calls.push('resolveFieldIds')
      return {}
    },
    async ensureMissingObjectFields({ projectId, objectId, fields: descriptors }) {
      calls.push('ensureMissingObjectFields')
      const addedFieldIds = []
      const skippedExistingFieldIds = []
      for (const descriptor of descriptors) {
        const physical = physicalFieldId(projectId, objectId, descriptor.id)
        if (fields.has(descriptor.id)) skippedExistingFieldIds.push(physical)
        else {
          fields.set(descriptor.id, {
            name: descriptor.name,
            type: descriptor.type,
            property: descriptor.property,
            order: descriptor.order,
          })
          addedFieldIds.push(physical)
        }
      }
      return { addedFieldIds, skippedExistingFieldIds }
    },
    async patchObjectFieldProperty({ fieldId, propertyPatch }) {
      calls.push('patchObjectFieldProperty')
      const current = fields.get(fieldId) || { name: fieldId, type: 'string', property: {}, order: 0 }
      fields.set(fieldId, {
        ...current,
        property: {
          ...current.property,
          stockPreparation: { ...(current.property.stockPreparation || {}), ...propertyPatch.stockPreparation },
        },
      })
      return { ok: true }
    },
    async ensureView({ descriptor }) {
      calls.push('ensureView')
      return { id: `view_${descriptor.id}` }
    },
  }
}

function createFakeDb() {
  const rows = new Map()
  return {
    rows,
    async upsertOne(table, row, { conflictColumns, updateColumns } = {}) {
      const key = conflictColumns.map((column) => String(row[column])).join(' ')
      const existing = rows.get(key)
      if (!existing) {
        const created = { ...row, last_install_at: 't1', created_at: 't1' }
        rows.set(key, created)
        return [created]
      }
      const updated = { ...existing }
      for (const column of updateColumns || Object.keys(row)) {
        if (conflictColumns.includes(column)) continue
        updated[column] = Object.prototype.hasOwnProperty.call(row, column) ? row[column] : 't2'
      }
      rows.set(key, updated)
      return [updated]
    },
    async select(table, { where } = {}) {
      return [...rows.values()].filter((row) =>
        Object.entries(where || {}).every(([column, value]) => row[column] === value))
    },
  }
}

// Every service createHandlers requires, stubbed to throw. None of the pack routes may touch one.
function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => {
      throw new Error(`unexpected service call: ${method}`)
    }
  }
  return service
}

function baseServices() {
  return {
    externalSystemRegistry: inertService(['upsertExternalSystem', 'getExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
    adapterRegistry: inertService(['createAdapter', 'listAdapterKinds']),
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

function mount({ packs, provisioning, packInstallStore, fieldPermissions } = {}) {
  const routes = new Map()
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: {
        provisioning: provisioning || createFakeProvisioning(),
        records: { async queryRecords() { return [] } },
      },
    },
    storage: new Map(),
    // SERVER config is the only place a pack can come from.
    config: packs === undefined ? {} : { stockPreparationCustomerPacks: packs },
  }
  const services = baseServices()
  if (packInstallStore) services.stockPreparationPackInstallStore = packInstallStore
  // The host capability, injected exactly the way core-backend injects it (index.ts gives it only
  // to plugin-integration-core). Absent by default, so every existing case here is unchanged.
  if (fieldPermissions) services.stockPreparationFieldPermissions = fieldPermissions
  httpRoutes.registerIntegrationRoutes({
    context,
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, context }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function call(routes, method, routePath, req = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  assert.notEqual(res.body, undefined, `${method} ${routePath} produced a body`)
  return res
}

const PACK_ROUTES = Object.freeze([
  ['GET', '/api/integration/stock-preparation/customer-packs', {}],
  ['GET', '/api/integration/stock-preparation/customer-packs/installs', {}],
  ['POST', '/api/integration/stock-preparation/customer-packs/:packId/dry-run', { params: { packId: PACK_ID } }],
  ['POST', '/api/integration/stock-preparation/customer-packs/:packId/install', { params: { packId: PACK_ID } }],
])

// ---------------------------------------------------------------------------
// 1. the gate
// ---------------------------------------------------------------------------

async function everyRouteIsAdminGated() {
  const provisioning = createFakeProvisioning()
  const store = createStockPreparationPackInstallStore({ db: createFakeDb(), idGenerator: () => 'ledger_1' })
  const { routes } = mount({ packs: { [PACK_ID]: SUITE_PACK }, provisioning, packInstallStore: store })

  for (const [method, routePath, extra] of PACK_ROUTES) {
    for (const user of [undefined, READER, WRITER]) {
      const res = await call(routes, method, routePath, { ...extra, user })
      assert.equal(res.body.ok, false, `${method} ${routePath} rejects ${user ? user.id : 'anonymous'}`)
      assert.ok([401, 403].includes(res.statusCode), `${method} ${routePath} -> ${res.statusCode}`)
    }
  }
  // The gate is BEFORE any host work: a rejected caller never reaches the provisioning API.
  assert.deepEqual(provisioning.calls, [], 'an unauthorized request performs no host call at all')
}

async function unlistedPackIdIsRefusedBeforeAnyHostCall() {
  const provisioning = createFakeProvisioning()
  const store = createStockPreparationPackInstallStore({ db: createFakeDb(), idGenerator: () => 'ledger_1' })
  const { routes } = mount({ packs: { [PACK_ID]: SUITE_PACK }, provisioning, packInstallStore: store })

  for (const routePath of [
    '/api/integration/stock-preparation/customer-packs/:packId/dry-run',
    '/api/integration/stock-preparation/customer-packs/:packId/install',
  ]) {
    for (const packId of ['some-other-pack', '', 'ROUTES-PACK']) {
      const res = await call(routes, 'POST', routePath, { user: ADMIN, params: { packId } })
      assert.equal(res.statusCode, 403)
      assert.equal(res.body.error.code, 'CUSTOMER_PACK_NOT_ALLOWED')
    }
  }
  assert.deepEqual(provisioning.calls, [], 'the allowlist is checked before the first host call')

  // Dormant by default: no server config → empty catalog → even a real packId is refused.
  const dormant = mount({ provisioning: createFakeProvisioning(), packInstallStore: store })
  const res = await call(dormant.routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/dry-run', {
    user: ADMIN,
    params: { packId: PACK_ID },
  })
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.error.code, 'CUSTOMER_PACK_NOT_ALLOWED')
  const listed = await call(dormant.routes, 'GET', '/api/integration/stock-preparation/customer-packs', { user: ADMIN })
  assert.equal(listed.body.data.packCount, 0)
}

// The body allowlist is the second half of "the pack is never request-supplied".
async function requestCannotSupplyAPackOrSteerTheTarget() {
  const provisioning = createFakeProvisioning()
  const store = createStockPreparationPackInstallStore({ db: createFakeDb(), idGenerator: () => 'ledger_1' })
  const { routes } = mount({ packs: { [PACK_ID]: SUITE_PACK }, provisioning, packInstallStore: store })

  const forbiddenBodies = [
    { pack: { packId: PACK_ID, packVersion: 1, extensionFields: [] } },
    { extensionFields: [{ id: 'ext_evil', label: 'x', type: 'string', ownership: 'plm_system' }] },
    { tenantId: 'tenant-b' },
    { projectId: 'tenant-b:integration-core' },
    { objectId: 'plm_stock_preparation_other' },
  ]
  for (const body of forbiddenBodies) {
    const res = await call(routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/install', {
      user: ADMIN,
      params: { packId: PACK_ID },
      body,
    })
    assert.equal(res.statusCode, 400, `body ${JSON.stringify(body)} is refused`)
    assert.equal(res.body.error.code, 'CUSTOMER_PACK_REQUEST_INVALID')
  }
  assert.deepEqual(provisioning.calls, [], 'a rejected body never reaches the host')

  // The one accepted key.
  const ok = await call(routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/install', {
    user: ADMIN,
    params: { packId: PACK_ID },
    body: { mode: 'reinstall' },
  })
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.data.ledger.mode, 'reinstall')
  assert.equal(ok.body.data.projectId, PROJECT_ID, 'the project is auth-derived, not request-derived')
}

// ---------------------------------------------------------------------------
// 2. dry run: zero writes
// ---------------------------------------------------------------------------

async function dryRunPerformsZeroWrites() {
  const provisioning = createFakeProvisioning()
  const store = createStockPreparationPackInstallStore({ db: createFakeDb(), idGenerator: () => 'ledger_1' })
  const db = createFakeDb()
  const recordingStore = createStockPreparationPackInstallStore({ db, idGenerator: () => 'ledger_1' })
  const { routes } = mount({ packs: { [PACK_ID]: SUITE_PACK }, provisioning, packInstallStore: recordingStore })

  const res = await call(routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/dry-run', {
    user: ADMIN,
    params: { packId: PACK_ID },
  })
  assert.equal(res.statusCode, 200)
  const plan = res.body.data

  // THE assertion: no call outside the read set — stated as a set difference so a future write
  // primitive is caught without anyone remembering to add it here.
  for (const method of provisioning.calls) {
    assert.equal(WRITE_METHODS.includes(method), false, `dry-run must not call ${method}`)
  }
  assert.deepEqual([...new Set(provisioning.calls)].sort(), ['findObjectSheet', 'readObjectFieldsContent'])
  assert.equal(provisioning.fields.size, 0, 'the sheet is untouched')
  assert.equal(db.rows.size, 0, 'a dry-run writes no ledger row either')

  // The SAME zero-writes claim over a sheet that would actually be PATCHED by an install. Without
  // this case the assertion above is vacuous for the stamp path: on an all-fresh sheet there is
  // nothing to stamp, so a dry-run that stamped anyway would still call nothing.
  const takeover = createFakeProvisioning({ seedUnstamped: true })
  const takeoverDb = createFakeDb()
  const takeoverMount = mount({
    packs: { [PACK_ID]: SUITE_PACK },
    provisioning: takeover,
    packInstallStore: createStockPreparationPackInstallStore({ db: takeoverDb, idGenerator: () => 'ledger_1' }),
  })
  const takeoverRes = await call(takeoverMount.routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/dry-run', {
    user: ADMIN,
    params: { packId: PACK_ID },
  })
  assert.equal(takeoverRes.statusCode, 200)
  assert.deepEqual(takeoverRes.body.data.willStampFieldIds, [EXT_HUMAN], 'the dry-run sees the stamp work')
  assert.deepEqual(takeoverRes.body.data.willCreateFieldIds, [EXT_PLM])
  for (const method of takeover.calls) {
    assert.equal(WRITE_METHODS.includes(method), false, `dry-run over a takeover sheet must not call ${method}`)
  }
  assert.deepEqual([...new Set(takeover.calls)].sort(), ['findObjectSheet', 'readObjectFieldsContent'])
  assert.deepEqual(takeover.fields.get(EXT_HUMAN).property, {}, 'the hand-built column is left unstamped')
  assert.equal(takeoverDb.rows.size, 0)

  assert.equal(plan.mode, 'dry_run')
  assert.equal(plan.canInstall, true)
  assert.deepEqual(plan.willCreateFieldIds, [EXT_HUMAN, EXT_PLM].sort())
  assert.deepEqual(plan.willStampFieldIds, [])
  assert.deepEqual(plan.conflictingFieldIds, [])
  assert.deepEqual(plan.counts, {
    extensionFields: 2, willCreate: 2, willStamp: 0, alreadyStamped: 0, conflicting: 0, optionSets: 0, roleViews: 1,
    // This pack declares no fieldWritePolicies, so the write-scope preview is empty on every axis:
    // nothing to deny, nothing found stale, and — since a pack that governs no region can request
    // no reconcile — nothing this install would retire and nothing left for an operator either.
    fieldWriteDenials: 0, staleWriteScopes: 0,
    willRemoveWriteScopes: 0, operatorMustClearWriteScopes: 0,
  })
  // The derived hidden ids the role view would ship, in the pack's own logical vocabulary.
  assert.equal(plan.roleViews.length, 1)
  assert.equal(plan.roleViews[0].roleViewId, 'production')
  assert.ok(plan.roleViews[0].hiddenFieldIds.includes(EXT_HUMAN), 'the human band is banded out by ownership')
  assert.ok(plan.roleViews[0].hiddenFieldIds.includes('path'), 'and the named id-noise column by name')
  // Per-field ownership, so a deployer reviews bands rather than a bare id list.
  for (const entry of plan.fields) {
    assert.deepEqual(Object.keys(entry).sort(), ['action', 'extension', 'fieldId', 'ownership', 'preserveOnRefresh'])
    assert.equal(entry.action, 'create')
  }
  assert.ok(store)
}

// A dry-run REPORTS a conflict; only the install refuses on one.
async function dryRunReportsConflictsInsteadOfThrowing() {
  const provisioning = createFakeProvisioning({ seedConflict: true })
  const db = createFakeDb()
  const store = createStockPreparationPackInstallStore({ db, idGenerator: () => 'ledger_1' })
  const { routes } = mount({ packs: { [PACK_ID]: SUITE_PACK }, provisioning, packInstallStore: store })

  const res = await call(routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/dry-run', {
    user: ADMIN,
    params: { packId: PACK_ID },
  })
  assert.equal(res.statusCode, 200, 'a conflict is a REPORT, not a route failure')
  assert.equal(res.body.data.canInstall, false)
  assert.deepEqual(res.body.data.conflictingFieldIds, [EXT_HUMAN])
  assert.equal(res.body.data.conflicts[0].property, 'ownership')

  // The install over the same sheet refuses, and writes nothing.
  const install = await call(routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/install', {
    user: ADMIN,
    params: { packId: PACK_ID },
  })
  assert.equal(install.statusCode, 409)
  assert.equal(install.body.error.code, 'CUSTOMER_PACK_OWNERSHIP_CONFLICT')
  assert.equal(db.rows.size, 0, 'a refused install leaves no ledger row')
}

// The canonical target is a PRECONDITION — the two-step flow the rehearsal report names (F5).
async function absentCanonicalTargetIsATwoStepSignal() {
  const provisioning = createFakeProvisioning({ sheetMissing: true })
  const store = createStockPreparationPackInstallStore({ db: createFakeDb(), idGenerator: () => 'ledger_1' })
  const { routes } = mount({ packs: { [PACK_ID]: SUITE_PACK }, provisioning, packInstallStore: store })

  for (const routePath of [
    '/api/integration/stock-preparation/customer-packs/:packId/dry-run',
    '/api/integration/stock-preparation/customer-packs/:packId/install',
  ]) {
    const res = await call(routes, 'POST', routePath, { user: ADMIN, params: { packId: PACK_ID } })
    assert.equal(res.statusCode, 409)
    assert.equal(res.body.error.code, 'CUSTOMER_PACK_TARGET_ABSENT')
    // The dry-run and the install give the SAME answer, so a deployer learns about step 1 without
    // having to attempt a write to find out.
  }
}

// ---------------------------------------------------------------------------
// 3. install + ledger read
// ---------------------------------------------------------------------------

async function installWritesTheLedgerAndTheReadRouteShowsIt() {
  const provisioning = createFakeProvisioning()
  const db = createFakeDb()
  const store = createStockPreparationPackInstallStore({ db, idGenerator: () => 'ledger_1' })
  const { routes } = mount({ packs: { [PACK_ID]: SUITE_PACK }, provisioning, packInstallStore: store })

  const before = await call(routes, 'GET', '/api/integration/stock-preparation/customer-packs/installs', { user: ADMIN })
  assert.equal(before.body.data.rowCount, 0)

  const res = await call(routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/install', {
    user: ADMIN,
    params: { packId: PACK_ID },
  })
  assert.equal(res.statusCode, 201, 'columns created -> 201')
  assert.equal(res.body.data.ledger.status, 'installed')
  assert.equal(res.body.data.objectId, OBJECT_ID)

  const after = await call(routes, 'GET', '/api/integration/stock-preparation/customer-packs/installs', { user: ADMIN })
  assert.equal(after.body.data.rowCount, 1)
  const row = after.body.data.installs[0]
  assert.deepEqual(Object.keys(row).sort(), [
    'fieldCount', 'installedFields', 'lastInstallAt', 'mode', 'packId', 'packVersion', 'status', 'summary', 'warnings',
  ])
  assert.equal(row.packId, PACK_ID)
  assert.equal(row.status, 'installed')
  assert.deepEqual(row.installedFields, [
    { fieldId: EXT_HUMAN, ownership: 'human_preserved', preserveOnRefresh: true, extension: true },
    { fieldId: EXT_PLM, ownership: 'plm_system', preserveOnRefresh: false, extension: true },
  ])

  // Idempotence through the route: a second install adds nothing and still leaves one row.
  const again = await call(routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/install', {
    user: ADMIN,
    params: { packId: PACK_ID },
  })
  assert.equal(again.statusCode, 200, 'nothing created -> 200')
  assert.equal(db.rows.size, 1)

  // No ledger configured → the INSTALL route fails closed. An install nobody can enumerate
  // afterwards is exactly the gap this line exists to close, so it is refused, not done quietly.
  const ledgerless = mount({ packs: { [PACK_ID]: SUITE_PACK }, provisioning: createFakeProvisioning() })
  const refused = await call(ledgerless.routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/install', {
    user: ADMIN,
    params: { packId: PACK_ID },
  })
  assert.equal(refused.statusCode, 501)
  assert.equal(refused.body.error.code, 'CUSTOMER_PACK_LEDGER_UNAVAILABLE')
  // …while the DRY RUN still works without one: it persists nothing, so it needs nothing.
  const dryRun = await call(ledgerless.routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/dry-run', {
    user: ADMIN,
    params: { packId: PACK_ID },
  })
  assert.equal(dryRun.statusCode, 200)
}

// ---------------------------------------------------------------------------
// 4. values-free
// ---------------------------------------------------------------------------

async function everyResponseIsValuesFree() {
  const provisioning = createFakeProvisioning()
  const store = createStockPreparationPackInstallStore({ db: createFakeDb(), idGenerator: () => 'ledger_1' })
  const { routes } = mount({ packs: { [PACK_ID]: SUITE_PACK }, provisioning, packInstallStore: store })

  const responses = []
  responses.push(await call(routes, 'GET', '/api/integration/stock-preparation/customer-packs', { user: ADMIN }))
  responses.push(await call(routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/dry-run', { user: ADMIN, params: { packId: PACK_ID } }))
  responses.push(await call(routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/install', { user: ADMIN, params: { packId: PACK_ID } }))
  responses.push(await call(routes, 'GET', '/api/integration/stock-preparation/customer-packs/installs', { user: ADMIN }))

  const serialized = JSON.stringify(responses.map((res) => res.body))
  // The pack's own labels are the customer's data. Ids and frozen ownership tokens leave; labels do not.
  for (const leak of ['旧系统ID', '毛胚长度', '生产备料视图', 'routes suite pack']) {
    assert.equal(serialized.includes(leak), false, `no route response may echo ${leak}`)
  }
  // The tokens that DO travel are the frozen vocabulary and nothing else.
  assert.ok(serialized.includes('plm_system') && serialized.includes('human_preserved'))
  assert.ok(serialized.includes(EXT_PLM) && serialized.includes(EXT_HUMAN))
}


// ---------------------------------------------------------------------------
// 5. the field-permission port, END TO END THROUGH THE ROUTE
// ---------------------------------------------------------------------------
//
// F5(a) of the adversarial review: every earlier witness for the write-scoping wiring calls
// `installCustomerPack` directly. That leaves the ONE line that actually connects the two —
// `fieldPermissions: stockPreparationFieldPermissions` inside the route handler — proven by nothing
// but a source read. These two cases exercise the real registerIntegrationRoutes -> handler ->
// installer -> port path, so deleting that line turns them RED.

const PORT_PACK_ID = 'routes-pack-scoped'
const PORT_PACK = Object.freeze({
  ...SUITE_PACK,
  packId: PORT_PACK_ID,
  // Both columns are on the frozen main template, so the declaration needs no extra ext_ column.
  fieldWritePolicies: [
    { roleId: 'routes:purchasing', ownsFieldIds: ['procurementReply', 'procurementDone'] },
    { roleId: 'routes:warehouse', ownsFieldIds: ['warehouseConfirmation', 'warehouseDone'] },
  ],
})

function createRecordingFieldPermissionsPort() {
  const applyCalls = []
  const listCalls = []
  const roleCalls = []
  return {
    applyCalls,
    listCalls,
    roleCalls,
    async applyRoleWriteScopes(input) {
      applyCalls.push(input)
      return { applied: input.entries.length, entries: input.entries }
    },
    async listRoleWriteScopes(input) {
      listCalls.push(input)
      return { sheetId: input.sheetId, entries: [] }
    },
    async findMissingRoleIds(input) {
      roleCalls.push(input)
      return { missing: [] }
    },
  }
}

async function theInstallRouteHandsThePackToTheHostPort() {
  const port = createRecordingFieldPermissionsPort()
  const store = createStockPreparationPackInstallStore({ db: createFakeDb(), idGenerator: () => 'ledger_1' })
  const { routes } = mount({
    packs: { [PORT_PACK_ID]: PORT_PACK },
    provisioning: createFakeProvisioning(),
    packInstallStore: store,
    fieldPermissions: port,
  })

  const res = await call(routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/install', {
    user: ADMIN,
    params: { packId: PORT_PACK_ID },
  })
  assert.ok([200, 201].includes(res.statusCode), `install succeeded (${res.statusCode})`)

  // THE ASSERTION THAT MATTERS: the port was reached, once, through the route.
  assert.equal(port.applyCalls.length, 1, 'the route wired the host port into the install')
  const applied = port.applyCalls[0]
  assert.equal(applied.sheetId, `sheet_${OBJECT_ID}`, 'addressed by the sheet the route resolved')
  assert.equal(applied.entries.length, 4, 'each of the 4 claimed columns denies the one role that does not own it')
  for (const entry of applied.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['fieldId', 'roleId'], 'nothing but the port shape reaches the port')
    assert.equal(entry.fieldId, physicalFieldId(PROJECT_ID, OBJECT_ID, entry.fieldId.split(`${OBJECT_ID}_`)[1]))
  }
  const deniedFor = (roleId) => applied.entries
    .filter((entry) => entry.roleId === roleId)
    .map((entry) => entry.fieldId.replace(`fld_${PROJECT_ID}_${OBJECT_ID}_`, ''))
    .sort()
  assert.deepEqual(deniedFor('routes:warehouse'), ['procurementDone', 'procurementReply'])
  assert.deepEqual(deniedFor('routes:purchasing'), ['warehouseConfirmation', 'warehouseDone'])

  // The pre-flight and the stale census went through the route too.
  assert.deepEqual(port.roleCalls, [{ roleIds: ['routes:purchasing', 'routes:warehouse'] }])
  assert.equal(port.listCalls.length, 1)
  assert.equal(res.body.data.writeScopeCheck, 'checked')
  assert.deepEqual(res.body.data.staleWriteScopes, [])
  assert.equal(res.body.data.appliedWriteScopes, 4)

  // And the DRY RUN previews the same plan without touching the port's write half.
  const dry = await call(routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/dry-run', {
    user: ADMIN,
    params: { packId: PORT_PACK_ID },
  })
  assert.equal(dry.statusCode, 200)
  assert.equal(dry.body.data.fieldPermissionsPortAvailable, true)
  assert.equal(dry.body.data.counts.fieldWriteDenials, 4)
  assert.equal(port.applyCalls.length, 1, 'the dry-run wrote no permission row')
}

async function aDeclaredPolicyWithNoHostPortIsACoded503() {
  // The inverse. Mounting WITHOUT the capability must refuse the install rather than report it
  // complete while the declared scoping would silently not be enforced.
  const store = createStockPreparationPackInstallStore({ db: createFakeDb(), idGenerator: () => 'ledger_2' })
  const provisioning = createFakeProvisioning()
  const { routes } = mount({
    packs: { [PORT_PACK_ID]: PORT_PACK },
    provisioning,
    packInstallStore: store,
    // no fieldPermissions
  })

  const res = await call(routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/install', {
    user: ADMIN,
    params: { packId: PORT_PACK_ID },
  })
  assert.equal(res.body.ok, false)
  assert.equal(res.statusCode, 503)
  assert.equal(res.body.error.code, 'CUSTOMER_PACK_FIELD_PERMISSIONS_UNAVAILABLE')
  // FAIL-CLOSED BEFORE THE FIRST SCHEMA WRITE: the refusal must leave the sheet untouched.
  for (const method of WRITE_METHODS) {
    assert.equal(provisioning.calls.includes(method), false, `${method} was never reached`)
  }
  // The dry-run says the same thing without throwing — that is its whole posture.
  const dry = await call(routes, 'POST', '/api/integration/stock-preparation/customer-packs/:packId/dry-run', {
    user: ADMIN,
    params: { packId: PORT_PACK_ID },
  })
  assert.equal(dry.statusCode, 200)
  assert.equal(dry.body.data.fieldPermissionsPortAvailable, false)
  assert.equal(dry.body.data.writeScopeCheck, 'port_absent')
  assert.equal(dry.body.data.canInstall, false)
}

async function main() {
  await everyRouteIsAdminGated()
  await unlistedPackIdIsRefusedBeforeAnyHostCall()
  await requestCannotSupplyAPackOrSteerTheTarget()
  await dryRunPerformsZeroWrites()
  await dryRunReportsConflictsInsteadOfThrowing()
  await absentCanonicalTargetIsATwoStepSignal()
  await installWritesTheLedgerAndTheReadRouteShowsIt()
  await everyResponseIsValuesFree()
  await theInstallRouteHandsThePackToTheHostPort()
  await aDeclaredPolicyWithNoHostPortIsACoded503()
}

main().then(
  () => {
    console.log('stock-preparation-customer-pack-routes.test.cjs OK')
  },
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
