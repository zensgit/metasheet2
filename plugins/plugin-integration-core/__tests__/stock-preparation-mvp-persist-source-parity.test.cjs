'use strict'

const { consumableMap } = require('./support/consumable-storage.cjs')

// #6475 fix round 1 — 批次存档 (mvp-persist, the project-sync panel's step ④) ARCHIVES THE SOURCE
// STEP ③ WROTE FROM, OR NOTHING. Through the real route table, the REAL source-binding store (over an
// in-memory db) and the panel's own request shapes.
//
// THE SPLIT. The panel's dry-run (①) and apply (③) carry the page scope as `?tenantId&workspaceId`
// (projectSync.ts `createStockPreparationProjectSyncApi`), so they resolve the action's source through
// `scopedInput` WITH a workspace hint. mvp-persist (④) refuses every query carrier
// (`assertStockPreparationTableActionMvpPersistNoSteering`), so it resolves with NONE. The binding
// store answers the two differently by design — a hint gets its own row, else the tenant's null row;
// no hint gets the null row, else a single sibling, else the deploy-time default — so ③ and ④ could
// resolve two different sources, and ④ answered 201 having archived the OTHER source's parts as this
// sync's batch.
//
// THE FIX (http-routes.cjs `assertMvpPersistReadsTheWrittenSource`). The apply answers a values-free
// digest of the (tenant, action, source) it read; the panel hands it back to ④; ④ refuses 409
// STOCK_PREPARATION_MVP_SOURCE_BINDING_SPLIT unless the source IT resolved has the same digest. A
// caller with no digest gets ④ only when no binding row of this (tenant, action) disagrees with what
// ④ resolved. Either way the check runs before the B2a claim, the source-system load and any read,
// and it never changes what ④ reads — only whether it may.
//
// CASES (the binding rows are seeded straight into the store's table, the way the delivery script's
// tenant-wide bind and the workbench picker's workspace bind leave them)
//   S1 null row → OLD, workbench row → NEW (review round 1, blocker 1). ① ready, ③ writes NEW's part;
//      ④ with the apply's digest refuses `not_the_written_source`, without it `bindings_disagree`; no
//      snapshot row in either; OLD's adapter is never created.
//   S2 two workspace rows (NEW under the page's hint, OLD under another), no null row (blocker 2):
//      ④ would have read the deploy-time default — refused both ways, nothing stored.
//   S3 S1 with the stale OLD source disabled (blocker 3): the answer is the split, never
//      TABLE_ACTION_SOURCE_NOT_ACTIVE, because the check runs before the source-system load.
//   S4 NO FALSE REFUSALS — the shapes that do agree archive the source ③ wrote from:
//      a single workbench row (no null row); the tenant-wide null row only; no binding anywhere; and a
//      null row plus a workbench row naming the SAME source, archived without a digest.
//   S5 what only the digest sees: one row under ANOTHER workspace, none under the page's hint, no null
//      row — ③ wrote the deploy-time default's part, ④ would read that row's. Refused.
//   S6 the digest binds the tenant: a digest one tenant's apply answered does not let another tenant's
//      archive proceed.
//   S7 a malformed digest is a 400 before any lookup; a store that cannot enumerate its rows, or more
//      rows than one page, is refused rather than vouched for; with no store at all every caller
//      resolves the deploy-time default and ④ proceeds.
//
// MUTATIONS this suite is calibrated against (in-memory, never on disk; each scenario run alone):
//   SP1 drop the `assertMvpPersistReadsTheWrittenSource` call from mvp-persist   => S1 S2 S3 S5 S6 S7 red
//   SP2 ignore the digest (always take the no-digest branch)                      => S1 S2 S3 S5 S6 red
//   SP3 drop the `bindings.some(…)` disagreement refusal                          => S1 S2 S3 red (no-digest legs)
//   SP4 drop the apply's `sourceScopeDigest`                                       => S1 S2 S3 S5 S6 red
//   SP5 accept an incomplete listing (`listed.complete !== true` removed)         => S7 red
//   SP6 leave the tenant out of the digest                                         => S6 red
//   SP7 / SP8 drop `tenant_id` / `action_id` from `listForAction`'s where-clause    => the store case red
//   SP9 let a malformed digest through as if absent                                => S7 red
//   H2  the pre-fix harness shape: ① and ③ without the page scope                  => S1 red (its control)
// S4 stays green under every one of them: none of them may cost an agreeing deployment its archive.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  BINDING_TABLE,
  LIST_FOR_ACTION_LIMIT,
  createStockPreparationSourceBindingStore,
} = require(path.join(LIB, 'stock-preparation-source-binding-store.cjs'))
const {
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  RUN_OBJECT_ID,
  PROJECT_OBJECT_ID,
} = require(path.join(LIB, 'stock-preparation-sync-run-persist.cjs'))

const MVP_PERSIST_GATE = 'MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED'
const TENANT_ID = 'tenant_1'
const OTHER_TENANT_ID = 'tenant_2'
const WS_PAGE = 'workspace_page'
const WS_OTHER = 'workspace_other'
const CANONICAL_OBJECT_ID = 'stockPreparationMain'
const CANONICAL_SHEET_ID = `sheet_${CANONICAL_OBJECT_ID}`
const TEMPLATE_FIELD_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id)
const PROJECT_NO = 'P-001'
const MVP_SHEET_IDS = Object.freeze([BATCH_OBJECT_ID, LINE_OBJECT_ID, RUN_OBJECT_ID, PROJECT_OBJECT_ID].map((id) => `sheet_${id}`))
const SPLIT = 'STOCK_PREPARATION_MVP_SOURCE_BINDING_SPLIT'
const DIGEST_SHAPE = /^[0-9a-f]{32}$/

// Three sources, each holding the SAME project with a DIFFERENT part — so which one a step read is
// visible in what it wrote. ENV is the deploy-time default the action config names.
const SRC = Object.freeze({ OLD: 'src_old', NEW: 'src_new', ENV: 'src_env' })
const PART_CODE = Object.freeze({ [SRC.OLD]: 'A-OLD', [SRC.NEW]: 'A-NEW', [SRC.ENV]: 'A-ENV' })

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function sourceData(systemId) {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: PROJECT_NO, Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-1', quantity: '2', sort_id: '10' }],
    DN_PDM_PartLibraryInfo: [{ OBJ_ID: 'PART-1', IdentityNo: PART_CODE[systemId], IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1' }],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
}

function createSourceAdapter(systemId, reads) {
  const data = sourceData(systemId)
  return {
    async read(input = {}) {
      reads.push(systemId)
      const rows = Array.isArray(data[input.object]) ? data[input.object] : []
      const matches = rows.filter((row) =>
        Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
      return { records: matches.map(clone), nextCursor: null, done: true }
    },
  }
}

function createRecordsApi() {
  const sheets = new Map()
  let seq = 0
  const sheetFor = (sheetId) => {
    if (!sheets.has(sheetId)) sheets.set(sheetId, new Map())
    return sheets.get(sheetId)
  }
  const api = {
    async queryRecords({ sheetId, filters, limit, offset } = {}) {
      const predicate = filters && typeof filters === 'object' ? filters : {}
      const all = [...sheetFor(sheetId).values()]
        .filter((row) => Object.entries(predicate).every(([key, value]) => row.data[key] === value))
        .map((row) => ({ id: row.id, sheetId: row.sheetId, version: 1, data: { ...row.data } }))
      const start = Number.isInteger(offset) ? offset : 0
      return Number.isInteger(limit) ? all.slice(start, start + limit) : all.slice(start)
    },
    async createRecord({ sheetId, data } = {}) {
      seq += 1
      const id = `rec_${seq}`
      sheetFor(sheetId).set(id, { id, sheetId, data: { ...data } })
      return { id, sheetId, version: 1, data: { ...data } }
    },
    async patchRecord({ sheetId, recordId, changes } = {}) {
      const existing = sheetFor(sheetId).get(recordId)
      if (!existing) throw new Error(`patchRecord: unknown record ${recordId}`)
      const data = { ...existing.data, ...(changes || {}) }
      sheetFor(sheetId).set(recordId, { id: recordId, sheetId, data })
      return { id: recordId, sheetId, version: 2, data: { ...data } }
    },
    async runStockPreparationPersistUnitOfWork(_input, operation) {
      return operation(api)
    },
  }
  return {
    api,
    rows(sheetId) {
      return [...sheetFor(sheetId).values()].map((row) => ({ id: row.id, data: { ...row.data } }))
    },
  }
}

function createProvisioning() {
  const identity = (fieldIds) => Object.fromEntries((Array.isArray(fieldIds) ? fieldIds : []).map((id) => [id, id]))
  return {
    getObjectSheetId(_projectId, objectId) {
      return `sheet_${objectId}`
    },
    async findObjectSheet({ objectId } = {}) {
      return { id: `sheet_${objectId}`, baseId: null, name: objectId, description: null }
    },
    async resolveFieldIds({ fieldIds } = {}) {
      return identity(fieldIds)
    },
    async resolveExistingObjectFieldIds({ fieldIds } = {}) {
      return identity(fieldIds)
    },
    async ensureObject() {
      throw new Error('ensureObject must never be called on this path')
    },
  }
}

// The binding store's db, in memory: pg result shape off insertOne/updateRow, a bare array off
// select. Rows are seeded straight into the table (`seedBinding`) — the delivery script's bare POST
// and the workbench picker's hinted POST both end as exactly such a row.
function createBindingDb() {
  const rows = []
  const matches = (row, where) => Object.entries(where || {}).every(([column, value]) => (row[column] ?? null) === (value ?? null))
  const handle = {
    rows,
    async selectOne(table, where) {
      return rows.find((row) => row.__table === table && matches(row, where)) || null
    },
    async select(table, options = {}) {
      const found = rows.filter((row) => row.__table === table && matches(row, options.where))
      return Number.isInteger(options.limit) ? found.slice(0, options.limit) : found
    },
    async insertOne() { throw new Error('the binding table is seeded directly in this suite') },
    async updateRow() { throw new Error('the binding table is seeded directly in this suite') },
    async selectOneForKeyShare() { throw new Error('the binding table is seeded directly in this suite') },
    async transaction(callback) { return callback(handle) },
  }
  return handle
}

function seedBinding(db, { tenantId = TENANT_ID, workspaceId = null, externalSystemId }) {
  db.rows.push({
    __table: BINDING_TABLE,
    id: `binding_${db.rows.length + 1}`,
    tenant_id: tenantId,
    workspace_id: workspaceId,
    action_id: PLM_STOCK_PREPARATION_ACTION_ID,
    external_system_id: externalSystemId,
    updated_by: null,
    created_at: 't0',
    updated_at: 't0',
  })
}

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
  }
  return service
}

function services({ bindingStore, disabled, reads, created }) {
  const system = (input = {}) => {
    if (!Object.values(SRC).includes(input.id)) return null
    return {
      id: input.id,
      tenantId: input.tenantId,
      name: 'Readonly PLM SQL',
      kind: 'data-source:sql-readonly',
      role: 'source',
      status: disabled.has(input.id) ? 'inactive' : 'active',
      config: { dataSourceId: `ds_${input.id}`, object: 'DN_PDM_PathExAttrInfo' },
    }
  }
  return {
    externalSystemRegistry: {
      ...inertService(['upsertExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
      async getExternalSystem(input = {}) { return system(input) },
      async getExternalSystemForAdapter(input = {}) {
        const found = system(input)
        return found ? { ...found, credentials: {} } : null
      },
    },
    adapterRegistry: {
      createAdapter(found) {
        created.push(found.id)
        return createSourceAdapter(found.id, reads)
      },
      listAdapterKinds() { return [] },
    },
    pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
    stockPreparationAuditStore: { async append() { return { ok: true } } },
    tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
    ...(bindingStore ? { stockPreparationSourceBindingStore: bindingStore } : {}),
  }
}

function actionConfig() {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: SRC.ENV, kind: 'data-source:sql-readonly' },
    target: {
      sheetId: CANONICAL_SHEET_ID,
      objectId: CANONICAL_OBJECT_ID,
      fieldIdMap: Object.fromEntries(TEMPLATE_FIELD_IDS.map((id) => [id, id])),
    },
  }
}

// `bindings`: rows to seed. `store`: 'real' (default), 'none' (not wired), or a replacement object.
function mount({ bindings = [], disabled = [], store = 'real' } = {}) {
  const routes = new Map()
  const records = createRecordsApi()
  const db = createBindingDb()
  for (const binding of bindings) seedBinding(db, binding)
  const bindingStore = store === 'real'
    ? createStockPreparationSourceBindingStore({ db })
    : (store === 'none' ? null : store)
  const reads = []
  const created = []
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: { provisioning: createProvisioning(), records: records.api },
    },
    storage: consumableMap(),
    config: {
      stockPreparationTableActions: [actionConfig()],
      stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [CANONICAL_OBJECT_ID] },
    },
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services: services({ bindingStore, disabled: new Set(disabled), reads, created }),
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, records, reads, created }
}

const ROUTE = Object.freeze({
  dryRun: '/api/integration/table-actions/:actionId/dry-run',
  apply: '/api/integration/table-actions/:actionId/apply',
  mvpPersist: '/api/integration/table-actions/:actionId/mvp-persist',
})
const ACTION_PARAMS = Object.freeze({ actionId: PLM_STOCK_PREPARATION_ACTION_ID })

function adminUser(tenantId = TENANT_ID) {
  return {
    id: 'user_admin',
    tenantId,
    roles: ['admin'],
    permissions: ['integration:admin', 'stock-prep:read', 'stock-prep:operate'],
  }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function call(routes, routePath, { body = {}, query = {}, tenantId = TENANT_ID } = {}) {
  const handler = routes.get(`POST ${routePath}`)
  assert.ok(handler, `route POST ${routePath} is registered`)
  const res = createResponse()
  try {
    await handler({ user: adminUser(tenantId), authenticatedTenantId: tenantId, body, query, params: ACTION_PARAMS }, res)
  } catch (error) {
    res.statusCode = error && error.status ? error.status : 500
    res.body = { ok: false, error: { code: error && error.code ? error.code : 'THREW', message: error && error.message, details: error && error.details ? { ...error.details } : undefined } }
  }
  assert.notEqual(res.body, undefined, `POST ${routePath} produced a body`)
  return res
}

// THE PANEL'S OWN SHAPES (projectSync.ts): ① and ③ carry the page scope as a query, ③ sends only the
// token, ④ carries no query and hands back the apply's digest.
const pageQuery = (tenantId = TENANT_ID, workspaceId = WS_PAGE) => ({ tenantId, workspaceId })
const pull = () => ({ parameters: { projectNo: PROJECT_NO } })

async function panelWrite(h, { tenantId = TENANT_ID, workspaceId = WS_PAGE } = {}) {
  const planned = await call(h.routes, ROUTE.dryRun, { body: pull(), query: pageQuery(tenantId, workspaceId), tenantId })
  assert.equal(planned.statusCode, 200, `① dry-run: ${JSON.stringify(planned.body)}`)
  assert.equal(planned.body.data.status, 'ready', '① control: the plan is ready')
  const applied = await call(h.routes, ROUTE.apply, {
    body: { ...pull(), confirm: { dryRunToken: planned.body.data.dryRunToken } },
    query: pageQuery(tenantId, workspaceId),
    tenantId,
  })
  assert.equal(applied.statusCode, 200, `③ apply: ${JSON.stringify(applied.body)}`)
  assert.equal(applied.body.data.status, 'succeeded', '③ control: the write succeeded')
  assert.equal(applied.body.data.apply.counts.created, 1, '③ control: one row written')
  return applied.body.data
}

function writtenPartCodes(h) {
  return h.records.rows(CANONICAL_SHEET_ID).map((row) => row.data.componentCode).sort()
}

function archivedPartCodes(h) {
  return h.records.rows(`sheet_${LINE_OBJECT_ID}`).map((row) => row.data.childDrawingNo).sort()
}

function snapshotRowCount(h) {
  return MVP_SHEET_IDS.reduce((total, sheetId) => total + h.records.rows(sheetId).length, 0)
}

async function archive(h, { digest, tenantId = TENANT_ID } = {}) {
  const body = digest === undefined ? pull() : { ...pull(), sourceScopeDigest: digest }
  return call(h.routes, ROUTE.mvpPersist, { body, query: {}, tenantId })
}

function assertSplit(res, reason, label) {
  assert.equal(res.statusCode, 409, `${label}: 409 (got ${res.statusCode} ${JSON.stringify(res.body && res.body.error)})`)
  assert.equal(res.body.error.code, SPLIT, `${label}: the typed split code — never NOT_ACTIVE, never a 201`)
  assert.deepEqual({ ...res.body.error.details }, { reason }, `${label}: reason ${reason}`)
}

// ── S1 ───────────────────────────────────────────────────────────────────────────────────────

async function s1NullRowAndWorkbenchRowDisagree() {
  const h = mount({
    bindings: [
      { workspaceId: null, externalSystemId: SRC.OLD },
      { workspaceId: WS_PAGE, externalSystemId: SRC.NEW },
    ],
  })
  const applied = await panelWrite(h)
  assert.deepEqual(writtenPartCodes(h), [PART_CODE[SRC.NEW]], 'S1 control: ③ wrote the page-hinted (NEW) source')
  assert.match(applied.sourceScopeDigest, DIGEST_SHAPE, 'S1: the apply answers the digest of the source it read')
  const readsBefore = h.reads.length

  assertSplit(await archive(h, { digest: applied.sourceScopeDigest }), 'not_the_written_source', 'S1 panel (with digest)')
  assertSplit(await archive(h), 'bindings_disagree', 'S1 no digest')
  assert.equal(snapshotRowCount(h), 0, 'S1: not one snapshot row — the OLD source part was never archived')
  assert.equal(h.reads.length, readsBefore, 'S1: ④ read no source at all')
  assert.ok(!h.created.includes(SRC.OLD), 'S1: the stale OLD source was never even loaded')
}

// ── S2 ───────────────────────────────────────────────────────────────────────────────────────

async function s2TwoWorkspaceRowsNoNullRow() {
  const h = mount({
    bindings: [
      { workspaceId: WS_PAGE, externalSystemId: SRC.NEW },
      { workspaceId: WS_OTHER, externalSystemId: SRC.OLD },
    ],
  })
  const applied = await panelWrite(h)
  assert.deepEqual(writtenPartCodes(h), [PART_CODE[SRC.NEW]], 'S2 control: ③ wrote the page-hinted (NEW) source')
  assertSplit(await archive(h, { digest: applied.sourceScopeDigest }), 'not_the_written_source', 'S2 panel (with digest)')
  assertSplit(await archive(h), 'bindings_disagree', 'S2 no digest')
  assert.equal(snapshotRowCount(h), 0, 'S2: nothing stored — the deploy-time default was never archived')
  assert.ok(!h.created.includes(SRC.ENV), 'S2: the deploy-time default source was never loaded')
}

// ── S3 ───────────────────────────────────────────────────────────────────────────────────────

async function s3StaleSourceDisabledAnswersTheSplitNotNotActive() {
  const h = mount({
    bindings: [
      { workspaceId: null, externalSystemId: SRC.OLD },
      { workspaceId: WS_PAGE, externalSystemId: SRC.NEW },
    ],
    disabled: [SRC.OLD],
  })
  const applied = await panelWrite(h)
  const res = await archive(h, { digest: applied.sourceScopeDigest })
  assert.notEqual(res.body.error && res.body.error.code, 'TABLE_ACTION_SOURCE_NOT_ACTIVE',
    'S3: a disabled stale source no longer answers in place of the split (re-enabling it would not fix the archive)')
  assertSplit(res, 'not_the_written_source', 'S3 panel (with digest)')
  assertSplit(await archive(h), 'bindings_disagree', 'S3 no digest')
  assert.equal(snapshotRowCount(h), 0, 'S3: nothing stored')
}

// ── S4 ───────────────────────────────────────────────────────────────────────────────────────

async function assertArchivesTheWrittenSource(label, mountInput, { withDigest = true } = {}) {
  const h = mount(mountInput)
  const applied = await panelWrite(h)
  const written = writtenPartCodes(h)
  const res = await archive(h, withDigest ? { digest: applied.sourceScopeDigest } : {})
  assert.equal(res.statusCode, 201, `${label}: archived (got ${res.statusCode} ${JSON.stringify(res.body && res.body.error)})`)
  assert.equal(res.body.data.persisted, true, `${label}: a new batch`)
  assert.deepEqual(archivedPartCodes(h), written, `${label}: the archived part is the part ③ wrote`)
}

async function s4AgreeingShapesStillArchive() {
  await assertArchivesTheWrittenSource('S4a single workbench row, no null row', {
    bindings: [{ workspaceId: WS_PAGE, externalSystemId: SRC.NEW }],
  })
  await assertArchivesTheWrittenSource('S4b tenant-wide null row only', {
    bindings: [{ workspaceId: null, externalSystemId: SRC.NEW }],
  })
  await assertArchivesTheWrittenSource('S4c no binding anywhere (deploy-time default)', { bindings: [] })
  await assertArchivesTheWrittenSource('S4c no binding anywhere, no digest', { bindings: [] }, { withDigest: false })
  await assertArchivesTheWrittenSource('S4d null row and workbench row agree, no digest', {
    bindings: [
      { workspaceId: null, externalSystemId: SRC.NEW },
      { workspaceId: WS_PAGE, externalSystemId: SRC.NEW },
    ],
  }, { withDigest: false })
}

// ── S5 ───────────────────────────────────────────────────────────────────────────────────────

async function s5OnlyTheDigestSeesAnUnhintedSingleRow() {
  const h = mount({ bindings: [{ workspaceId: WS_OTHER, externalSystemId: SRC.NEW }] })
  const applied = await panelWrite(h)
  assert.deepEqual(writtenPartCodes(h), [PART_CODE[SRC.ENV]],
    'S5 control: the page hint has no row of its own and there is no null row, so ③ wrote the deploy-time default')
  assertSplit(await archive(h, { digest: applied.sourceScopeDigest }), 'not_the_written_source', 'S5 panel (with digest)')
  assert.equal(snapshotRowCount(h), 0, 'S5: the other workspace row\'s part was not archived as this sync')
}

// ── S6 ───────────────────────────────────────────────────────────────────────────────────────

async function s6TheDigestBindsTheTenant() {
  // Two mounts (one sheet set each), the SAME deploy-time default source in both.
  const foreign = await panelWrite(mount({ bindings: [] }), { tenantId: OTHER_TENANT_ID, workspaceId: WS_PAGE })
  assert.match(foreign.sourceScopeDigest, DIGEST_SHAPE)
  const h = mount({ bindings: [] })
  const own = await panelWrite(h)
  assert.notEqual(foreign.sourceScopeDigest, own.sourceScopeDigest, 'S6 control: same source, different tenant, different digest')
  const before = snapshotRowCount(h)
  assertSplit(await archive(h, { digest: foreign.sourceScopeDigest }), 'not_the_written_source', 'S6 another tenant\'s digest')
  assert.equal(snapshotRowCount(h), before, 'S6: nothing stored')
}

// ── S7 ───────────────────────────────────────────────────────────────────────────────────────

async function s7MalformedDigestAndUnverifiableStores() {
  for (const digest of ['', 'ABCDEF0123456789ABCDEF0123456789', 'x'.repeat(32), 42, null]) {
    const h = mount({ bindings: [] })
    const res = await archive(h, { digest })
    assert.equal(res.statusCode, 400, `S7 malformed digest ${JSON.stringify(digest)}: 400`)
    assert.equal(res.body.error.code, 'TABLE_ACTION_REQUEST_INVALID')
    assert.deepEqual({ ...res.body.error.details }, { field: 'sourceScopeDigest' })
    assert.equal(h.created.length, 0, 'S7: refused before any source was loaded')
  }

  // A store that resolves bindings but cannot enumerate them: no digest → unverifiable.
  const getOnly = mount({ store: { async get() { return null }, async set() { throw new Error('unused') } } })
  await panelWrite(getOnly)
  assertSplit(await archive(getOnly), 'bindings_unverifiable', 'S7 store without listForAction')

  // More rows than one page: the real store says `complete: false`, and that is refused.
  const crowded = Array.from({ length: LIST_FOR_ACTION_LIMIT + 1 }, (_, index) => ({
    workspaceId: `workspace_${index}`,
    externalSystemId: SRC.ENV,
  }))
  const many = mount({ bindings: crowded })
  await panelWrite(many, { workspaceId: 'workspace_0' })
  assertSplit(await archive(many), 'bindings_unverifiable', 'S7 incomplete listing')
  assert.equal(snapshotRowCount(many), 0)

  // No store wired at all: nothing can be bound, every caller resolves the deploy-time default.
  await assertArchivesTheWrittenSource('S7 no store wired, no digest', { store: 'none' }, { withDigest: false })
}

// ── the store method on its own ───────────────────────────────────────────────────────────────

async function storeListForActionIsScopedAndBounded() {
  const db = createBindingDb()
  seedBinding(db, { workspaceId: null, externalSystemId: SRC.OLD })
  seedBinding(db, { workspaceId: WS_PAGE, externalSystemId: SRC.NEW })
  seedBinding(db, { tenantId: OTHER_TENANT_ID, workspaceId: WS_PAGE, externalSystemId: SRC.ENV })
  db.rows.push({ ...db.rows[0], id: 'other_action', action_id: 'another.action.v1', external_system_id: SRC.ENV })
  const store = createStockPreparationSourceBindingStore({ db })
  const listed = await store.listForAction({ tenantId: TENANT_ID, actionId: PLM_STOCK_PREPARATION_ACTION_ID })
  assert.equal(listed.complete, true)
  assert.deepEqual(listed.bindings.map((binding) => [binding.workspaceId, binding.externalSystemId]).sort(),
    [[WS_PAGE, SRC.NEW], [null, SRC.OLD]].sort(), 'only this tenant\'s rows of this action, null row included')
  await assert.rejects(() => store.listForAction({ actionId: PLM_STOCK_PREPARATION_ACTION_ID }), /tenantId is required/)
}

async function main() {
  const previousGate = process.env[MVP_PERSIST_GATE]
  process.env[MVP_PERSIST_GATE] = 'true'
  try {
    await storeListForActionIsScopedAndBounded()
    await s1NullRowAndWorkbenchRowDisagree()
    await s2TwoWorkspaceRowsNoNullRow()
    await s3StaleSourceDisabledAnswersTheSplitNotNotActive()
    await s4AgreeingShapesStillArchive()
    await s5OnlyTheDigestSeesAnUnhintedSingleRow()
    await s6TheDigestBindsTheTenant()
    await s7MalformedDigestAndUnverifiableStores()
  } finally {
    if (previousGate === undefined) delete process.env[MVP_PERSIST_GATE]
    else process.env[MVP_PERSIST_GATE] = previousGate
  }
  console.log('stock-preparation-mvp-persist-source-parity tests passed')
}

require('./support/fail-closed-suite-runner.cjs').runFailClosedMain('stock-preparation-mvp-persist-source-parity.test.cjs', main)
