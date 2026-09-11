'use strict'

// THE WIRING, large-BOM side: `installedFieldProperties` through the real HTTP routes.
//
// `stock-preparation-pack-install-readback.test.cjs` pins the seam (ledger -> live host read ->
// pack-aware bands) and `stock-preparation-pack-aware-refresh.test.cjs` pins what the bands DO.
// Neither says anything about whether a route hands the bands over. Until this change three routes
// did (small dry-run, confirmation decisions, small apply) and the large-BOM family did not, so a
// project that tipped into the background lane — which is not an operator's choice:
// `read_time_limit_exceeded` alone moves an unchanged project there — planned and wrote through
// template-only bands, i.e. WITHOUT the customer pack's `ext_` columns, while the small path planned
// with them. Same sheet, same tenant, two different writable bands decided by how slow the source
// was that morning.
//
// What this suite pins, through `registerIntegrationRoutes` and nothing mocked below it:
//
//   1. DEGRADED RESOLUTION IS THE OLD BEHAVIOUR, and all THREE degradations are one behaviour: no
//      ledger service at all / a ledger read that throws / a ledger that names no column. Each
//      produces the SAME plan payload, with no `ext_` id in either band and no pack stanza — the key
//      set a pre-wiring deployment produced. (The remaining half of "byte-identical", that
//      `installedFieldProperties: undefined` equals omitting the argument, is pinned one layer down
//      in stock-preparation-large-bom-jobs.test.cjs.)
//   2. AN INSTALLED PACK REACHES THE LARGE-BOM PLAN: its `plm_system` `ext_` columns join the plan's
//      writable band and its `human_preserved` ones join the wall.
//   3. AND REACHES THE CHUNKED WRITE: the apply writer's human wall rejects a pack `ext_` human
//      column BY NAME. The control — the same plan on a deployment with no ledger — writes it.
//   4. THE APPLY BAND IS FROZEN AT APPROVAL. The `.../run` route performs NO ledger read: an
//      install (or a UI column deletion) between two chunks of one approved job cannot change the
//      band the remaining chunks write through.
//   5. A BAND WITHOUT A MAPPING NEVER BLANKS AN `ext_` VALUE. The large-BOM path still supplies no
//      `extFieldMapping`, so its rows carry no `ext_` key; `pickFields` skips an undefined cell and
//      a patch does not blank what it omits, so an `ext_` value an earlier small-path refresh wrote
//      survives the large-BOM refresh untouched.
//
// Hermetic and dependency-free: no DB, no network, no filesystem writes, no clock assertions. The
// customer pack is the REAL committed rehearsal pack, so a change to its ownership split fails this
// suite instead of silently agreeing with it. Values-free: the only literals are schema ids, frozen
// ownership tokens and synthetic cell text.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  PLM_STOCK_PREPARATION_ACTION_ID,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  FACTORY_A_REHEARSAL_PACK,
} = require(path.join(LIB, 'customer-packs', 'factory-a.rehearsal.cjs'))

const PACK = FACTORY_A_REHEARSAL_PACK
const PACK_ID = PACK.packId
const TENANT_ID = 'tenant_1'
// A SANDBOX target: the production canonical objectId is never appliable on this path
// (assertStockPrepApplySandboxAllowed, reason `prod_canonical`), so a suite that applied would be
// asserting a 403 instead of a write.
const OBJECT_ID = 'stockPreparationLargeBomSandbox'
assert.notEqual(OBJECT_ID, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId)
const SOURCE_SYSTEM_ID = 'plm_sql_source'
const SHEET_ID = 'sheet_stock_large_bom'
const PROJECT_NO = 'P-001'

// Read off the pack rather than restated, so a change to the pack's bands breaks this suite.
const PACK_PLM_FIELDS = PACK.extensionFields.filter((field) => field.ownership === 'plm_system').map((field) => field.id)
const PACK_HUMAN_FIELDS = PACK.extensionFields.filter((field) => field.ownership === 'human_preserved').map((field) => field.id)
const EXT_PLM = 'ext_designer'
const EXT_HUMAN = 'ext_blankLength'
assert.ok(PACK_PLM_FIELDS.includes(EXT_PLM), 'the rehearsal pack must declare ext_designer as plm_system')
assert.ok(PACK_HUMAN_FIELDS.includes(EXT_HUMAN), 'the rehearsal pack must declare ext_blankLength as human_preserved')

const READ_USER = Object.freeze({ id: 'user_read', tenantId: TENANT_ID, permissions: ['integration:read'] })
const ADMIN_USER = Object.freeze({ id: 'user_admin', tenantId: TENANT_ID, roles: ['admin'], permissions: ['integration:admin'] })

let passed = 0
const failures = []

async function run(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(name)
    console.error(`FAIL: ${name}`)
    console.error(error && error.stack ? error.stack : error)
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────────

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function sourceData() {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: PROJECT_NO, Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2' }],
    DN_PDM_PartLibraryInfo: [{
      OBJ_ID: 'PART-A',
      IdentityNo: 'A-001',
      IdentityName: 'Assembly',
      Material: 'Steel',
      SysVer: 'V1',
      Designer: 'designer-one',
      SortNo: '10',
    }],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
}

function createSourceAdapter(data = sourceData()) {
  return {
    async read(input = {}) {
      const rows = Array.isArray(data[input.object]) ? data[input.object] : []
      const matches = rows.filter((row) =>
        Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
      return { records: matches.map(clone), nextCursor: null, done: true }
    },
  }
}

/**
 * Records-API spy. `calls` keeps the UN-CLONED payload beside a defensive clone; every negative
 * assertion reads the un-cloned one, because a JSON round trip DELETES keys whose value is
 * `undefined` and would make "no `ext_` key was produced" indistinguishable from "an `ext_` key was
 * produced holding undefined" — the distinction the no-blanking proof rests on.
 */
function createRecordsApi() {
  const rows = []
  const calls = []
  const record = (name, input) => calls.push([name, clone(input), input])
  return {
    rows,
    calls,
    payloads(name) {
      return calls.filter(([callName]) => callName === name).map((call) => call[2])
    },
    api: {
      async queryRecords(input = {}) {
        record('queryRecords', input)
        return rows
          .filter((row) => row.sheetId === input.sheetId)
          .filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row.data[field] === expected))
          .map(clone)
      },
      async createRecord(input = {}) {
        record('createRecord', input)
        const created = { id: `rec_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
        rows.push(created)
        return clone(created)
      },
      async patchRecord(input = {}) {
        record('patchRecord', input)
        const row = rows.find((entry) => entry.id === input.recordId)
        row.version += 1
        row.data = { ...row.data, ...(input.changes || {}) }
        return clone(row)
      },
    },
  }
}

// The stanza the pack INSTALLER stamps, restated (same discipline as the pack-aware refresh suite)
// so a silent change to the installer surfaces here as a failure rather than as agreeing drift.
function packStanza(ownership) {
  return {
    ownership,
    preserveOnRefresh: ownership === 'human_preserved',
    required: false,
    key: false,
    extension: true,
    packId: PACK.packId,
    packVersion: '1.0.0',
  }
}

/**
 * The install ledger, mutable and counting. `fieldIds` is what the pack installer would have
 * recorded; emptying it mid-suite stands for "the pack was uninstalled / its columns were deleted
 * while a job was mid-flight", and `calls` is how the suite proves which ROUTE performed a read.
 */
function createLedger({ fieldIds = PACK.extensionFields.map((field) => field.id), fail = false } = {}) {
  const ledger = {
    fieldIds: fieldIds.slice(),
    calls: [],
    async listInstalledFieldIds(input = {}) {
      ledger.calls.push(clone(input))
      if (fail) throw Object.assign(new Error('ledger unavailable'), { code: 'LEDGER_READ_FAILED' })
      return { fieldIds: ledger.fieldIds.slice() }
    },
  }
  return ledger
}

function createProvisioning() {
  return {
    async readObjectFieldsContent({ fieldIds }) {
      const out = {}
      for (const fieldId of fieldIds) {
        const declared = PACK.extensionFields.find((field) => field.id === fieldId)
        if (!declared) continue
        out[fieldId] = {
          name: fieldId,
          type: declared.type,
          property: { stockPreparation: packStanza(declared.ownership) },
          order: 10,
        }
      }
      return out
    },
    async findObjectSheet() { return { id: SHEET_ID, baseId: null, name: OBJECT_ID, description: null } },
  }
}

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
  }
  return service
}

function baseServices(sourceAdapter, ledger) {
  const services = {
    externalSystemRegistry: {
      ...inertService(['upsertExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
      async getExternalSystem(input = {}) {
        return {
          id: input.id,
          tenantId: input.tenantId,
          name: 'Readonly PLM SQL',
          kind: 'data-source:sql-readonly',
          role: 'source',
          status: 'active',
          config: { dataSourceId: 'ds_plm', object: 'DN_PDM_PathExAttrInfo' },
        }
      },
    },
    adapterRegistry: {
      createAdapter() { return sourceAdapter },
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
  }
  // ABSENT, not stubbed, when the deployment has no ledger: that is the shape of a host that never
  // installed the pack-install store, and `loadPackInstalledFieldProperties` must degrade on it.
  if (ledger) services.stockPreparationPackInstallStore = ledger
  return services
}

// Explicit physical bindings for every template column AND every pack column, so an `ext_` key in a
// written payload proves the map addressed it (mapFieldName refuses to fall back for an `ext_` id
// under an explicit map) — and so the control deployment is able to write the column the guarded one
// refuses, which is what makes the guarded assertion mean anything.
function resolvedFieldIdMap() {
  const map = Object.fromEntries(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => [field.id, `fld_${field.id}`]))
  for (const field of PACK.extensionFields) map[field.id] = `fld_${field.id}`
  return map
}

function actionConfig() {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: SOURCE_SYSTEM_ID, kind: 'data-source:sql-readonly' },
    target: {
      sheetId: SHEET_ID,
      objectId: OBJECT_ID,
      fieldIdMap: resolvedFieldIdMap(),
    },
    extensionFieldIds: PACK.extensionFields.map((field) => field.id),
  }
}

function mount({ ledger, records, sourceAdapter } = {}) {
  const routes = new Map()
  const recordsApi = records || createRecordsApi()
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: {
        provisioning: createProvisioning(),
        records: recordsApi.api,
      },
    },
    // `durable: true` is what the large-BOM job store demands before it accepts a job.
    storage: Object.assign(new Map(), { durable: true }),
    config: {
      stockPreparationTableActions: [actionConfig()],
      stockPreparationCustomerPacks: { [PACK_ID]: PACK },
      stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [OBJECT_ID] },
    },
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services: baseServices(sourceAdapter || createSourceAdapter(), ledger),
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, context, records: recordsApi }
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

const JOBS_ROUTE = '/api/integration/table-actions/:actionId/large-bom/expansion-jobs'
const RUN_ROUTE = `${JOBS_ROUTE}/:jobId/run`
const PLAN_ROUTE = `${JOBS_ROUTE}/:jobId/plan`
const APPLY_START_ROUTE = `${JOBS_ROUTE}/:jobId/apply-jobs`
const APPLY_RUN_ROUTE = `${JOBS_ROUTE}/:jobId/apply-jobs/:applyJobId/run`
const ACTION_ID = PLM_STOCK_PREPARATION_ACTION_ID

/** Start -> run -> plan, i.e. everything the background lane does before a human approves a write. */
async function expandAndPlan(routes) {
  const started = await call(routes, 'POST', JOBS_ROUTE, {
    user: READ_USER,
    params: { actionId: ACTION_ID },
    body: { parameters: { projectNo: PROJECT_NO } },
  })
  assert.equal(started.statusCode, 202, JSON.stringify(started.body))
  const jobId = started.body.data.jobId
  const params = { actionId: ACTION_ID, jobId }

  const ran = await call(routes, 'POST', RUN_ROUTE, { user: READ_USER, params })
  assert.equal(ran.statusCode, 200, JSON.stringify(ran.body))
  assert.equal(ran.body.data.authoritative, true, 'the expansion must seal an authoritative artifact')

  const planned = await call(routes, 'POST', PLAN_ROUTE, { user: READ_USER, params, body: {} })
  assert.equal(planned.statusCode, 200, JSON.stringify(planned.body))
  return { jobId, planned }
}

async function approveAndRunApply(routes, jobId) {
  const started = await call(routes, 'POST', APPLY_START_ROUTE, {
    user: ADMIN_USER,
    params: { actionId: ACTION_ID, jobId },
    body: { confirm: { acceptManualConfirmHold: true } },
  })
  assert.equal(started.statusCode, 202, JSON.stringify(started.body))
  const applyJobId = started.body.data.jobId
  const ran = await call(routes, 'POST', APPLY_RUN_ROUTE, {
    user: ADMIN_USER,
    params: { actionId: ACTION_ID, jobId, applyJobId },
  })
  assert.equal(ran.statusCode, 200, JSON.stringify(ran.body))
  return { applyJobId, started, ran }
}

/** The stored expansion job, straight out of the route's own durable storage. */
function storedJob(context, predicate) {
  for (const [key, value] of context.storage.entries()) {
    if (typeof key === 'string' && predicate(key, value)) return { key, value }
  }
  throw new Error('no stored job matched')
}

function extIdsIn(list) {
  return list.filter((id) => id.startsWith('ext_'))
}

// ── 1. every degraded resolution is the pre-wiring behaviour, and they agree ──

async function degradedResolutionPlansExactlyWhatItAlwaysPlanned() {
  const payloads = []
  for (const ledger of [undefined, createLedger({ fail: true }), createLedger({ fieldIds: [] })]) {
    const { routes } = mount({ ledger })
    const { planned } = await expandAndPlan(routes)
    const plan = planned.body.data.evidence.plan
    assert.deepEqual(extIdsIn(plan.plmSystemFields), [], 'no band => no ext_ id is writable')
    assert.deepEqual(extIdsIn(plan.humanPreservedFields), [], 'no band => no ext_ id is on the wall')
    assert.equal(
      Object.prototype.hasOwnProperty.call(plan, 'packAwareOwnership'),
      false,
      'a degraded deployment gains no pack stanza at all',
    )
    // `jobId` is a fresh uuid per call and the expansion timestamps are wall-clock; everything else
    // is the payload a pre-wiring deployment produced.
    payloads.push(JSON.stringify({ ...planned.body.data, jobId: 'fixed' }))
  }
  assert.equal(payloads[0], payloads[1], 'a ledger that THROWS plans what no ledger at all plans')
  assert.equal(payloads[0], payloads[2], 'a ledger that names no column plans the same thing again')
}

// ── 2. an installed pack reaches the large-BOM PLAN ──────────────────────────

async function installedPackWidensTheLargeBomPlanBand() {
  const ledger = createLedger()
  const { routes } = mount({ ledger })
  const { planned } = await expandAndPlan(routes)
  const plan = planned.body.data.evidence.plan

  assert.deepEqual(extIdsIn(plan.plmSystemFields).sort(), PACK_PLM_FIELDS.slice().sort(), 'every pack plm_system column joins the plan writable band')
  assert.deepEqual(extIdsIn(plan.humanPreservedFields).sort(), PACK_HUMAN_FIELDS.slice().sort(), 'every pack human column joins the wall')
  assert.deepEqual(plan.packAwareOwnership.unclassifiedPackFieldIds, [], 'nothing in the real pack is unclassifiable')
  assert.ok(ledger.calls.length >= 1, 'the plan route is what read the ledger')
  // The ledger read is scoped to the tenant on the request and to the STORED job snapshot's target
  // sheet — never to a caller-supplied object.
  for (const readCall of ledger.calls) {
    assert.equal(readCall.tenantId, TENANT_ID)
    assert.equal(readCall.objectId, OBJECT_ID)
  }
  // Values-free: ids and frozen ownership tokens, never a source cell.
  assert.equal(JSON.stringify(planned.body).includes('designer-one'), false)
}

// ── 3./4. the band reaches the chunked WRITE, and it is frozen at approval ───
//
// The large-BOM path supplies no `extFieldMapping`, so its own expansion rows never carry an `ext_`
// key and the wall would have nothing to refuse. The decision below is therefore injected into the
// STORED plan — standing in for the plan a mapper-wired expansion (or any future producer) would
// hand the same apply job — because what is under test here is the WALL at write time, not who
// filled the cell.

function injectExtHumanFieldIntoStoredPlan(context) {
  const { key, value } = storedJob(context, (storageKey, stored) => Boolean(stored && stored.planArtifact))
  const decisions = value.planArtifact.plan.decisions
  const add = decisions.find((decision) => decision.decision === 'add')
  assert.ok(add, 'the fixture must produce an add decision to carry the column')
  add.record[EXT_HUMAN] = 7
  context.storage.set(key, value)
  return add.idempotencyKey
}

async function theApprovedBandRejectsAPackHumanColumnByName() {
  const ledger = createLedger()
  const { routes, context, records } = mount({ ledger })
  const { jobId } = await expandAndPlan(routes)
  injectExtHumanFieldIntoStoredPlan(context)

  const readsBeforeApproval = ledger.calls.length
  const startedApply = await call(routes, 'POST', APPLY_START_ROUTE, {
    user: ADMIN_USER,
    params: { actionId: ACTION_ID, jobId },
    body: { confirm: { acceptManualConfirmHold: true } },
  })
  assert.equal(startedApply.statusCode, 202, JSON.stringify(startedApply.body))
  const applyJobId = startedApply.body.data.jobId
  assert.ok(ledger.calls.length > readsBeforeApproval, 'approval is where the apply band is resolved')

  // FROZEN: the approved job carries the band, and it is PRIVATE state — the public projection is a
  // whitelist, so no band ever leaves the process.
  const approved = storedJob(context, (storageKey, stored) => Boolean(stored && stored.jobId === applyJobId)).value
  assert.deepEqual(
    approved.installedFieldProperties.map((entry) => entry.fieldId).sort(),
    PACK.extensionFields.map((field) => field.id).sort(),
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(startedApply.body.data, 'installedFieldProperties'),
    false,
    'the band is never projected into a response',
  )

  // THE LEDGER MOVES UNDER THE APPROVED JOB. A live per-chunk read would hand the chunk a band that
  // no longer knows `ext_blankLength`.
  ledger.fieldIds = []
  const readsBeforeRun = ledger.calls.length
  const ran = await call(routes, 'POST', APPLY_RUN_ROUTE, {
    user: ADMIN_USER,
    params: { actionId: ACTION_ID, jobId, applyJobId },
  })
  assert.equal(ran.statusCode, 200, JSON.stringify(ran.body))
  assert.equal(ledger.calls.length, readsBeforeRun, 'a chunk run performs NO ledger read at all')
  assert.equal(ran.body.data.counts.failed, 1, 'the approved band rejects the pack human column')
  assert.equal(ran.body.data.counts.created, 0)
  assert.deepEqual(records.payloads('createRecord'), [], 'and nothing was written')

  // THE CONTROL that makes the assertion above mean something: the same injected plan on a
  // deployment with NO ledger writes that very column. So it is the band doing the refusing.
  const control = mount({ ledger: undefined })
  const controlPlan = await expandAndPlan(control.routes)
  injectExtHumanFieldIntoStoredPlan(control.context)
  const controlApply = await approveAndRunApply(control.routes, controlPlan.jobId)
  assert.equal(controlApply.ran.body.data.counts.created, 1)
  assert.equal(controlApply.ran.body.data.counts.failed, 0)
  const written = control.records.payloads('createRecord')[0].data
  assert.equal(written[`fld_${EXT_HUMAN}`], 7, 'without a band the pack human column is written — the outcome the band prevents')
}

// ── 5. a band without a mapping never blanks an `ext_` value ─────────────────

async function aPackAwareBandNeverBlanksAnExtValueTheSmallPathWrote() {
  const ledger = createLedger()
  const { routes, context, records } = mount({ ledger })

  // First refresh: the row is created by the large-BOM path, with no `ext_` cell anywhere.
  const first = await expandAndPlan(routes)
  await approveAndRunApply(routes, first.jobId)
  assert.equal(records.rows.length, 1, 'the first refresh creates the row')
  assert.equal(
    Object.keys(records.payloads('createRecord')[0].data).filter((key) => key.startsWith('fld_ext_')).length,
    0,
    'with no extFieldMapping the large-BOM path fills no ext_ column, band or no band',
  )

  // An earlier SMALL-path refresh (the only path that applies a mapping today) is what puts a value
  // in the tenant column. Written straight into the store, because this suite mounts no mapper.
  records.rows[0].data[`fld_${EXT_PLM}`] = 'LEGACY_EXT_VALUE'

  // Second refresh, same project, same sheet, pack still installed: the band now contains
  // `ext_designer`, so the planner COMPARES it (the row differs from an incoming row that has no
  // such key) — but `pickFields` skips `row[field] === undefined`, so the patch never carries it.
  const second = await expandAndPlan(routes)
  const secondApply = await approveAndRunApply(routes, second.jobId)
  assert.equal(secondApply.ran.body.data.counts.failed, 0, JSON.stringify(secondApply.ran.body))
  assert.equal(records.rows.length, 1, 'the second refresh must not create a second row')
  // NOT a vacuous loop below: the row IS rewritten. The band made `ext_designer` a compared
  // column, and an existing value compared against an absent incoming one reads as CHANGED — so a
  // row that would previously have been SKIPped becomes an UPDATE until a mapping is configured.
  // More writes, never a lost cell: the patch below carries the canonical columns and no ext_ id.
  assert.equal(secondApply.ran.body.data.counts.updated, 1)
  assert.equal(records.payloads('patchRecord').length, 1, 'exactly one patch, so the omission assertion is real')

  for (const payload of records.payloads('patchRecord')) {
    // UN-CLONED: a JSON round trip would drop an `undefined`-valued key and make this vacuous.
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.changes, `fld_${EXT_PLM}`),
      false,
      'a patch built from a pack-aware band still omits an ext_ column nothing filled',
    )
  }
  assert.equal(
    records.rows[0].data[`fld_${EXT_PLM}`],
    'LEGACY_EXT_VALUE',
    'the value an earlier small-path refresh wrote survives the large-BOM refresh untouched',
  )
  assert.equal(records.rows[0].data.fld_componentCode, 'A-001', 'and the canonical half is refreshed as always')
}

async function main() {
  await run('degraded resolution plans exactly what it always planned', degradedResolutionPlansExactlyWhatItAlwaysPlanned)
  await run('an installed pack widens the large-BOM plan band', installedPackWidensTheLargeBomPlanBand)
  await run('the approved band rejects a pack human column by name', theApprovedBandRejectsAPackHumanColumnByName)
  await run('a pack-aware band never blanks an ext_ value', aPackAwareBandNeverBlanksAnExtValueTheSmallPathWrote)

  if (failures.length > 0) {
    console.error(`stock-preparation-large-bom-installed-fields-wiring.test.cjs FAILED (${failures.length})`)
    process.exit(1)
  }
  console.log(`stock-preparation-large-bom-installed-fields-wiring.test.cjs OK (${passed})`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
