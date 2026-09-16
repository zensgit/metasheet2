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
//   6. THE PRODUCTION CLEAN-ROW BOUND COUNTS ONLY ROWS THE INTAKE REALLY CHANGED. X6 之前 this item
//      read "THE PRICE OF 5, AND IT IS NOT FREE": the SKIP-to-UPDATE flip fed the large-BOM apply
//      route's `maxCleanRows` bound (derived from the plan's add+update count), so on a deployment an
//      owner put in production mode the widened band pushed a one-row refresh over its authorized
//      bound and took a 403 every round. X6 之后 the flip is gone, band and no-band count the same,
//      and the case pins that — with a second control proving the bound still bites when two rows
//      really do move, so the 200 is a count of 1 and not a dormant gate.
//   5. A BAND WITHOUT A MAPPING NEVER BLANKS AN `ext_` VALUE. The large-BOM path still supplies no
//      `extFieldMapping`, so its rows carry no mapper-filled `ext_` key. X6 之前 the planner still
//      COMPARED that absent cell against the stored value, called it changed, and emitted a patch
//      that omitted the column; X6 之后 an absent incoming cell is not a change at all, so the row is
//      a SKIP and no patch goes out. Either way the value an earlier small-path refresh wrote
//      survives untouched — the case now pins the stronger of the two outcomes.
//   7. THE DEFAULT DEPLOYMENT (no production policy) ONLY REWRITES ROWS THE INTAKE REALLY CHANGED.
//      X6 之前 this was "the other half of 6": nothing refused the flip there, so every row already
//      carrying an `ext_` value was REALLY patched on every refresh, and the patch stamped
//      `lastPlmRefreshDecision = update` plus a `lastPlmConflictSummary` naming `ext_designer` — a
//      reason that patch did not honour, since it carried no `ext_` column. X6 之后 that whole cost
//      is gone: the untouched row is not patched, its four refresh stamps stop at the last real
//      change, and the one patch that does go out names only the columns the intake moved. What the
//      band still buys here is pinned positively instead: the F1c planner-derived pack column
//      reaches the patch only because the band contains it, while mapper territory stays empty.
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
const {
  PROD_CANONICAL_OBJECT_ID,
} = require(path.join(LIB, 'stock-preparation-production-policy.cjs'))

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
// The one pack column this suite's fixture can fill WITHOUT an `extFieldMapping`: F1c derives
// 名称及规格 inside the planner, from the expansion row, and it only survives `pickFields` when the
// pack-aware band contains it. It is therefore the positive evidence that the band reached the
// plan — as opposed to `EXT_PLM`, which is mapper territory and stays empty on this path.
const DERIVED_EXT = 'ext_nameAndSpec'
assert.ok(PACK_PLM_FIELDS.includes(DERIVED_EXT), 'the rehearsal pack must declare ext_nameAndSpec as plm_system')
assert.notEqual(DERIVED_EXT, EXT_PLM)

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

function sourceData({ parts = ['A'] } = {}) {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: PROJECT_NO, Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: parts.map((suffix) => ({ order_id: 'ORDER-1', part_id: `PART-${suffix}`, quantity: '2' })),
    DN_PDM_PartLibraryInfo: parts.map((suffix, index) => ({
      OBJ_ID: `PART-${suffix}`,
      IdentityNo: `${suffix}-001`,
      IdentityName: 'Assembly',
      Material: 'Steel',
      SysVer: 'V1',
      Designer: 'designer-one',
      SortNo: `${10 + index}`,
    })),
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
      // #5590 (G4/M2) 起 registerIntegrationRoutes 硬依赖 getExternalSystemForAdapter（去掉了
      // credential-stripped 回退）。适配器加载走的就是这条（会解密），返回与 getExternalSystem 同一系统。
      async getExternalSystemForAdapter(input = {}) {
        return {
          id: input.id,
          tenantId: input.tenantId,
          name: 'Readonly PLM SQL',
          kind: 'data-source:sql-readonly',
          role: 'source',
          status: 'active',
          config: { dataSourceId: 'ds_plm', object: 'DN_PDM_PathExAttrInfo' },
          credentials: {},
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

function actionConfig(objectId = OBJECT_ID) {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: SOURCE_SYSTEM_ID, kind: 'data-source:sql-readonly' },
    target: {
      sheetId: SHEET_ID,
      objectId,
      fieldIdMap: resolvedFieldIdMap(),
    },
    extensionFieldIds: PACK.extensionFields.map((field) => field.id),
  }
}

function mount({ ledger, records, sourceAdapter, objectId = OBJECT_ID, applyProduction } = {}) {
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
      stockPreparationTableActions: [actionConfig(objectId)],
      stockPreparationCustomerPacks: { [PACK_ID]: PACK },
      // Left in place even on the production mount below: with a production policy present the gate
      // never consults it, so a 403 carrying the SANDBOX code would prove the production branch was
      // not the one that ran.
      stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [OBJECT_ID] },
      // Mounted only when a case asks for it, and MUTABLE on purpose: the production case lowers
      // `maxCleanRows` between two authorization windows the way an owner sizes a window to the
      // delta one refresh is expected to touch.
      ...(applyProduction ? { stockPrepApplyProduction: applyProduction } : {}),
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
//
// X6 之前(#5686 / caf8128ad 合入前):来料没有 `ext_designer` 这个键,`changedFields` 把它取到
// `undefined`、折成 `null` 后与存量真值比较必然不等 ⇒ 整行被判 UPDATE,第二轮刷新发出 1 次
// `patchRecord`(patch 里恰恰没有 `ext_designer`)。这一段旧断言钉的就是那次「说变了却什么也没写」。
// X6 之后:`intakeProvidesField`(conflict-planner)让来料缺席的键不再算变更,该行退回 SKIP ——
// `updated: 0 / skipped: 1`、零 `patchRecord`。本用例的结论(带不会抹掉小 BOM 写过的 `ext_` 值)不变,
// 变的是它现在由「patch 省略该列」升级为「根本不发 patch」,所以下面改为按 X6 后的真实计数钉住,
// 并补钉 SKIP 行的刷新戳停在上一轮(X6 正文里那条有界表述在这条路径上的落点)。

async function aPackAwareBandNeverBlanksAnExtValueTheSmallPathWrote() {
  const ledger = createLedger()
  const { routes, records } = mount({ ledger })

  // First refresh: the row is created by the large-BOM path.
  const first = await expandAndPlan(routes)
  await approveAndRunApply(routes, first.jobId)
  assert.equal(records.rows.length, 1, 'the first refresh creates the row')
  // WHAT THE BAND ADMITS WITH NO MAPPER CONFIGURED, stated as a CLOSED SET rather than as "none".
  // Before F1c (also on main now) the honest assertion here was `0 ext_ keys`; F1c derives three
  // pack ids inside the planner — from the EXPANSION row, not from any `extFieldMapping` — so this
  // fixture legitimately fills `ext_nameAndSpec`. What must still hold, and is the whole point of
  // this case, is that no MAPPER-territory column such as `ext_designer` is filled on this path.
  assert.deepEqual(
    Object.keys(records.payloads('createRecord')[0].data).filter((key) => key.startsWith('fld_ext_')).sort(),
    [`fld_${DERIVED_EXT}`],
    'with no extFieldMapping the only ext_ column the large-BOM path fills is the planner-derived one',
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(records.payloads('createRecord')[0].data, `fld_${EXT_PLM}`),
    false,
    'and never a mapper-territory ext_ column',
  )
  // THE CONTROL that keeps the line above from being a tautology: without a ledger the band is
  // template-only, the derived id is not in it, and the create carries NO ext_ key at all. So the
  // one key above is the BAND admitting a value, not the expansion leaking one.
  {
    const control = mount({ ledger: undefined })
    const controlFirst = await expandAndPlan(control.routes)
    await approveAndRunApply(control.routes, controlFirst.jobId)
    assert.deepEqual(
      Object.keys(control.records.payloads('createRecord')[0].data).filter((key) => key.startsWith('fld_ext_')),
      [],
      'a template-only band admits no ext_ column at all',
    )
  }

  // An earlier SMALL-path refresh (the only path that applies a mapping today) is what puts a value
  // in the tenant column. Written straight into the store, because this suite mounts no mapper.
  records.rows[0].data[`fld_${EXT_PLM}`] = 'LEGACY_EXT_VALUE'
  const patchesBeforeSecond = records.payloads('patchRecord').length

  // Second refresh, same project, same sheet, pack still installed: the band contains
  // `ext_designer`, but the incoming row does not DEFINE that cell, so since X6 it is not a change.
  const second = await expandAndPlan(routes)
  const secondApply = await approveAndRunApply(routes, second.jobId)
  assert.equal(secondApply.ran.body.data.counts.failed, 0, JSON.stringify(secondApply.ran.body))
  assert.equal(records.rows.length, 1, 'the second refresh must not create a second row')
  // NOT a vacuous loop below — it is now an EMPTY one, and that is the stronger outcome. X6 之前:
  // updated 1 + exactly one patchRecord whose keys omitted `ext_designer`. X6 之后: the row the
  // intake did not change is a SKIP, so there is no patch to omit anything from.
  assert.equal(secondApply.ran.body.data.counts.updated, 0, 'X6: an absent incoming cell is not a change')
  assert.equal(secondApply.ran.body.data.counts.skipped, 1)
  assert.equal(
    records.payloads('patchRecord').length,
    patchesBeforeSecond,
    'and no patchRecord at all is emitted for it',
  )

  for (const payload of records.payloads('patchRecord').slice(patchesBeforeSecond)) {
    // UN-CLONED: a JSON round trip would drop an `undefined`-valued key and make this vacuous.
    // Kept as a standing guard: if any future change re-introduces a patch here it must still omit
    // the column nothing filled.
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
  assert.equal(records.rows[0].data.fld_componentCode, 'A-001', 'and the canonical half is exactly as the first refresh left it')
  // X6 的有界表述在这条路径上的落点:SKIP 行的四列刷新戳不再逐轮盖章,停在最后一次真变更
  // (这里就是第一轮那次 add)。
  assert.equal(records.rows[0].data.fld_lastPlmRefreshDecision, 'add', 'a SKIP does not re-stamp the refresh decision')
  assert.equal(records.rows[0].data.fld_lastPlmConflictSummary, '', 'nor invent a conflict summary')
}

// -- 6. the production clean-row bound counts only rows the intake really changed --
//
// X6 之前(#5686 / caf8128ad 合入前),本用例叫 `theWidenedBandIsCountedByTheProductionCleanRowBound`
// (#5625 正文与 X6 提交信息里点名的就是这个名字):案例 5 里那次 SKIP→UPDATE 的翻转不止停在响应里的
// 计数上 —— 大 BOM apply 路由用 plan 的 add+update 数算出 `largeBomCleanRowCount`,喂给生产闸的
// `maxCleanRows`。于是一次真实 delta 只有一行的刷新会被当成 N 行(N = 表里带 `ext_` 值的行数)而被
// 403 拒,且每轮都拒。旧断言钉的正是 banded 403 / control 200 这组反差。
//
// X6 之后:`changedFields` 收窄,来料没给的格不再算变更,那次翻转不复存在 —— banded 与 control 数出
// 同一个数,同一个 `maxCleanRows=1` 的窗口两边都过。所以本用例现在钉的是反过来的一句:
// **带不再移动这个计数**,一次真实 delta 为一行的刷新在按一行授权的窗口内正常写。
//
// 两个对照组,缺一不可,否则「200」这个结论是空的:
//   * NO-LEDGER 对照 —— 同场景无账本(模板带),计数与写入与 banded 逐项相同;证明差别真的没了,
//     而不是场景本身退化成了别的东西。
//   * BOUND-BITES 对照 —— 同场景但上游真的动了两行,同一个 `maxCleanRows=1` 窗口 ⇒ 403
//     `STOCK_PREP_PRODUCTION_APPLY_DENIED` / `max_clean_rows_exceeded` 且零写入;证明上面那次 200
//     是「计数确实是 1」,不是生产闸压根没接线或休眠。

function largeBomProductionPolicy(maxCleanRows) {
  return {
    enabled: true,
    // The policy contract accepts only the production canonical target, so this case is the one
    // mount in the suite that binds the action to it.
    authorizedTargetObjectId: PROD_CANONICAL_OBJECT_ID,
    authorizationId: 'auth-large-bom-window',
    allowedActionId: ACTION_ID,
    allowedRoute: 'large',
    maxCleanRows,
    // Inside the bounded authorization window, which the contract checks against the route's clock.
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    requireFreshDryRun: true,
  }
}

/**
 * Two rows land; an earlier small-path refresh left an `ext_` value on BOTH; the caller says which
 * of them really change upstream and how many clean rows the owner authorized for the second
 * window. Returns the `.../run` response UN-asserted so each arm can read it.
 */
async function productionRefreshAfterAnEarlierExtWrite({ ledger, changedDetailIndexes = [1], maxCleanRows = 1 }) {
  const data = sourceData({ parts: ['A', 'B'] })
  const mounted = mount({
    ledger,
    sourceAdapter: createSourceAdapter(data),
    objectId: PROD_CANONICAL_OBJECT_ID,
    applyProduction: largeBomProductionPolicy(2),
  })
  const { routes, context, records } = mounted

  const first = await expandAndPlan(routes)
  const firstApply = await approveAndRunApply(routes, first.jobId)
  assert.equal(firstApply.ran.body.data.counts.created, 2, JSON.stringify(firstApply.ran.body))

  // The only path that applies a mapping today wrote a tenant value onto both rows.
  for (const row of records.rows) row.data[`fld_${EXT_PLM}`] = 'LEGACY_EXT_VALUE'
  // Upstream, the named rows genuinely changed: a canonical plm_system column moved. Quantity, not
  // one of the four IDENTITY columns — an identity move is adjudicated as a manual_confirm and
  // would never reach the clean-row count this case is about.
  for (const index of changedDetailIndexes) data.DN_PDM_OrderDetailInfo[index].quantity = '5'
  // A NEW authorization window, sized to the delta the owner expects.
  context.config.stockPrepApplyProduction = largeBomProductionPolicy(maxCleanRows)

  const second = await expandAndPlan(routes)
  const started = await call(routes, 'POST', APPLY_START_ROUTE, {
    user: ADMIN_USER,
    params: { actionId: ACTION_ID, jobId: second.jobId },
    body: { confirm: { acceptManualConfirmHold: true } },
  })
  assert.equal(started.statusCode, 202, JSON.stringify(started.body))
  const patchesBeforeRun = records.payloads('patchRecord').length
  const ran = await call(routes, 'POST', APPLY_RUN_ROUTE, {
    user: ADMIN_USER,
    params: { actionId: ACTION_ID, jobId: second.jobId, applyJobId: started.body.data.jobId },
  })
  return { ran, records, patchesBeforeRun }
}

async function theProductionCleanRowBoundIsNotMovedByThePackAwareBand() {
  const banded = await productionRefreshAfterAnEarlierExtWrite({ ledger: createLedger() })
  // X6 之前这里是 403 STOCK_PREP_PRODUCTION_APPLY_DENIED / max_clean_rows_exceeded 且零写入。
  assert.equal(banded.ran.statusCode, 200, JSON.stringify(banded.ran.body))
  assert.equal(banded.ran.body.ok, true)
  assert.deepEqual(
    banded.ran.body.data.counts,
    { created: 0, updated: 1, inactive: 0, skipped: 1, held: 0, failed: 0 },
    'the pack-aware band no longer turns the untouched ext_-carrying row into a counted UPDATE',
  )
  assert.equal(
    banded.records.payloads('patchRecord').length,
    banded.patchesBeforeRun + 1,
    'exactly one real write, for the one row that really moved',
  )
  assert.equal(banded.records.rows[0].data[`fld_${EXT_PLM}`], 'LEGACY_EXT_VALUE')
  assert.equal(banded.records.rows[1].data[`fld_${EXT_PLM}`], 'LEGACY_EXT_VALUE')

  // CONTROL A — identical scenario, no ledger: template-only band, same count, same write.
  // X6 之前这一组是与 banded 的唯一差别所在(200 vs 403);现在两边逐项相同,而那正是要钉的事。
  const control = await productionRefreshAfterAnEarlierExtWrite({ ledger: undefined })
  assert.equal(control.ran.statusCode, 200, JSON.stringify(control.ran.body))
  assert.deepEqual(control.ran.body.data.counts, banded.ran.body.data.counts, 'band and no band now count the same')
  assert.equal(control.records.payloads('patchRecord').length, control.patchesBeforeRun + 1)

  // CONTROL B — the bound still BITES. Same banded deployment, same `maxCleanRows: 1` window, but
  // upstream really moved BOTH rows: the count is genuinely 2, the production gate refuses
  // fail-closed before any write. Without this arm the 200 above could equally mean "the gate is
  // not wired on this route".
  const overBound = await productionRefreshAfterAnEarlierExtWrite({
    ledger: createLedger(),
    changedDetailIndexes: [0, 1],
    maxCleanRows: 1,
  })
  assert.equal(overBound.ran.statusCode, 403, JSON.stringify(overBound.ran.body))
  assert.equal(overBound.ran.body.ok, false)
  // The PRODUCTION branch is what refused: a sandbox refusal of the canonical target carries
  // STOCK_PREP_APPLY_SANDBOX_ONLY / prod_canonical, so this code proves which gate ran.
  assert.equal(overBound.ran.body.error.code, 'STOCK_PREP_PRODUCTION_APPLY_DENIED')
  assert.equal(overBound.ran.body.error.details.reason, 'max_clean_rows_exceeded')
  assert.equal(
    overBound.records.payloads('patchRecord').length,
    overBound.patchesBeforeRun,
    'fail-closed: the bound rejects BEFORE any write, so the refresh is lost and never a row',
  )
  assert.equal(overBound.records.rows[0].data[`fld_${EXT_PLM}`], 'LEGACY_EXT_VALUE')
}

// -- 7. THE DEFAULT DEPLOYMENT: what the band costs there, now that X6 landed ---
//
// X6 之前(#5686 / caf8128ad 合入前),本用例叫
// `theDefaultDeploymentPaysInWritesAndInAnUnhonouredRefreshReason`(#5625 正文与 X6 提交信息里点名的
// 就是这个名字),钉的是案例 6 的另一半:案例 6 是配了生产策略那半边(403 拦在写之前),而绝大多数
// 部署根本没配生产策略,那里没有任何东西拦这次 SKIP→UPDATE 的翻转 —— 它被执行。每一行已经带着
// `ext_` 值的记录在每轮大 BOM 刷新里都被真实 `patchRecord` 一次,并且那次 patch 把
// `lastPlmRefreshDecision` 写成 `update`、把 `lastPlmConflictSummary` 写成点名 `ext_designer` 的理由 ——
// 而 `pickFields` 恰恰把 `ext_designer` 排除在这次 patch 之外。旧断言钉的就是 updated:2 / skipped:0、
// 两次真实写、以及那条不成立的理由。
//
// X6 之后:`changedFields` 不再把来料缺席的键算成变更,这半边代价整个消失 —— updated 1 / skipped 1、
// 只有真正变了的那行被写、未变那行连刷新戳都不再被逐轮盖章、摘要里点名的是真变了的两列
// (`rawQuantity` / `totalQuantity`)而不是任何 `ext_` 列。**#5625 正文里披露的 (a)(b) 两支代价到此
// 都不存在了,本支只剩接带本身。**
//
// 那么带在这条路径上还买到什么?一件真实的事,并且现在由本用例正向钉住:F1c 在 planner 里派生的
// `ext_nameAndSpec` 只有进了 pack-aware 带才会被 `pickFields` 投影进 patch。所以下面在同一次 patch 上
// 同时钉两件事 —— 派生列在(带买到的),`ext_designer` 不在(mapper territory,这条路径仍没有 mapper)。
//
// CONTROL 同前:同场景无账本 ⇒ 计数与写入次数逐项相同,但 patch 里没有那个派生列,未变那行同样不被写。

/**
 * Two rows, an earlier small-path `ext_` value on both, exactly one genuine upstream change.
 * Also returns the refresh stamps the FIRST round left on the row nothing later changes, so the
 * caller can pin that a SKIP leaves them exactly where they were.
 */
async function defaultDeploymentRefreshAfterAnEarlierExtWrite({ ledger }) {
  const data = sourceData({ parts: ['A', 'B'] })
  const { routes, records } = mount({ ledger, sourceAdapter: createSourceAdapter(data) })

  const first = await expandAndPlan(routes)
  const firstApply = await approveAndRunApply(routes, first.jobId)
  assert.equal(firstApply.ran.body.data.counts.created, 2, JSON.stringify(firstApply.ran.body))

  for (const row of records.rows) row.data[`fld_${EXT_PLM}`] = 'LEGACY_EXT_VALUE'
  // Upstream, ONE row genuinely changed (quantity -> totalQuantity, not an IDENTITY column).
  data.DN_PDM_OrderDetailInfo[1].quantity = '5'

  const untouchedBefore = records.rows.find((row) => row.data.fld_componentCode === 'A-001')
  assert.ok(untouchedBefore, 'the fixture must have landed a row for A-001')
  const stampsBefore = {
    runId: untouchedBefore.data.fld_lastPlmRefreshRunId,
    at: untouchedBefore.data.fld_lastPlmRefreshAt,
    decision: untouchedBefore.data.fld_lastPlmRefreshDecision,
    summary: untouchedBefore.data.fld_lastPlmConflictSummary,
  }

  const patchesBeforeRun = records.payloads('patchRecord').length
  const second = await expandAndPlan(routes)
  const secondApply = await approveAndRunApply(routes, second.jobId)
  return { ran: secondApply.ran, records, patchesBeforeRun, stampsBefore }
}

function rowByComponentCode(records, componentCode) {
  const row = records.rows.find((entry) => entry.data.fld_componentCode === componentCode)
  assert.ok(row, `the fixture must have landed a row for ${componentCode}`)
  return row
}

async function theDefaultDeploymentOnlyRewritesRowsTheIntakeReallyChanged() {
  const banded = await defaultDeploymentRefreshAfterAnEarlierExtWrite({ ledger: createLedger() })
  assert.equal(banded.ran.statusCode, 200, JSON.stringify(banded.ran.body))
  // X6 之前:updated 2 / skipped 0,两次真实 patchRecord。
  assert.deepEqual(
    banded.ran.body.data.counts,
    { created: 0, updated: 1, inactive: 0, skipped: 1, held: 0, failed: 0 },
    'only the row the intake really changed is rewritten',
  )
  const patches = banded.records.payloads('patchRecord')
  assert.equal(patches.length, banded.patchesBeforeRun + 1, 'one real patchRecord call, not a counter')

  // THE ROW NOTHING UPSTREAM CHANGED IS NOT TOUCHED AT ALL — X6 之前它被 patch 了一次。
  const untouched = rowByComponentCode(banded.records, 'A-001')
  assert.equal(
    patches.some((payload) => payload.recordId === untouched.id),
    false,
    'the row nothing upstream changed is not patched even though the band compares its ext_ column',
  )
  // …and its four refresh stamps stop at the last real change instead of being re-stamped every
  // round. X6 之前它们每轮都被盖成本次 run 的值,同时 decision 写 `update`、summary 点名 `ext_designer`。
  assert.deepEqual(
    {
      runId: untouched.data.fld_lastPlmRefreshRunId,
      at: untouched.data.fld_lastPlmRefreshAt,
      decision: untouched.data.fld_lastPlmRefreshDecision,
      summary: untouched.data.fld_lastPlmConflictSummary,
    },
    banded.stampsBefore,
    'a SKIP leaves the four refresh stamps exactly where the last real change left them',
  )
  assert.equal(untouched.data[`fld_${EXT_PLM}`], 'LEGACY_EXT_VALUE', 'still never blanked')

  // THE ONE PATCH THAT DID GO OUT names the columns that really moved — no ext_ column anywhere in
  // the reason. X6 之前这里是 `{"type":"plm_system_refresh","changedFields":["ext_designer"]}`,
  // 一条这次 patch 并不兑现的理由。
  const changed = rowByComponentCode(banded.records, 'B-001')
  const changedPatch = patches.slice(banded.patchesBeforeRun).find((payload) => payload.recordId === changed.id)
  assert.ok(changedPatch, 'the row that really changed is the one that was patched')
  assert.equal(changedPatch.changes.fld_lastPlmRefreshDecision, 'update')
  assert.deepEqual(
    JSON.parse(changedPatch.changes.fld_lastPlmConflictSummary),
    { type: 'plm_system_refresh', changedFields: ['rawQuantity', 'totalQuantity'] },
    'the 冲突摘要 column names exactly the columns the intake moved, and no ext_ column',
  )
  // WHAT THE BAND STILL BUYS ON THIS PATH, pinned positively: the planner-derived pack column is
  // projected into the patch only because the band contains it…
  assert.equal(
    changedPatch.changes[`fld_${DERIVED_EXT}`],
    'Assembly',
    'the pack-aware band is what lets the planner-derived pack column reach the patch',
  )
  // …while a mapper-territory column stays out, because this family still supplies no
  // `extFieldMapping`. UN-CLONED payload: a JSON round trip would drop an `undefined`-valued key.
  assert.equal(
    Object.prototype.hasOwnProperty.call(changedPatch.changes, `fld_${EXT_PLM}`),
    false,
    'and a column no mapper filled is still omitted',
  )
  assert.equal(changed.data[`fld_${EXT_PLM}`], 'LEGACY_EXT_VALUE', 'never blanked on the written row either')

  // CONTROL — same scenario, no ledger. Same counts and same write volume (that is the X6 result),
  // but the template-only band drops the derived pack column, which is the difference the band makes.
  const control = await defaultDeploymentRefreshAfterAnEarlierExtWrite({ ledger: undefined })
  assert.deepEqual(control.ran.body.data.counts, banded.ran.body.data.counts, 'band and no band write the same rows')
  assert.equal(control.records.payloads('patchRecord').length, control.patchesBeforeRun + 1)
  const controlUntouched = rowByComponentCode(control.records, 'A-001')
  assert.equal(
    control.records.payloads('patchRecord').some((payload) => payload.recordId === controlUntouched.id),
    false,
    'without the band the untouched row stays a SKIP and keeps the refresh record it already had',
  )
  const controlPatch = control.records.payloads('patchRecord').slice(control.patchesBeforeRun)[0]
  assert.equal(
    Object.prototype.hasOwnProperty.call(controlPatch.changes, `fld_${DERIVED_EXT}`),
    false,
    'a template-only band leaves the planner-derived pack column out of the patch',
  )
}

async function main() {
  await run('degraded resolution plans exactly what it always planned', degradedResolutionPlansExactlyWhatItAlwaysPlanned)
  await run('an installed pack widens the large-BOM plan band', installedPackWidensTheLargeBomPlanBand)
  await run('the approved band rejects a pack human column by name', theApprovedBandRejectsAPackHumanColumnByName)
  await run('a pack-aware band never blanks an ext_ value', aPackAwareBandNeverBlanksAnExtValueTheSmallPathWrote)
  await run('the production clean-row bound is not moved by the pack-aware band', theProductionCleanRowBoundIsNotMovedByThePackAwareBand)
  await run('the default deployment only rewrites rows the intake really changed', theDefaultDeploymentOnlyRewritesRowsTheIntakeReallyChanged)

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
