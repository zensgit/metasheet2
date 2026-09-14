'use strict'

// 目标表字段存在性探针 — THROUGH THE REAL ROUTE TABLE.
//
// The unit suite (stock-preparation-target-field-existence-probe.test.cjs) proves the probe inside
// `computeDryRun`. This one proves the WIRING: that `POST /table-actions/:actionId/dry-run` and
// `.../apply` thread `{ provisioning, projectId }` from the host's own provisioning surface and the
// AUTHENTICATED tenant's staging project, that a request cannot name that input, and that a host
// without the DB-backed read gets a route response identical to the pre-probe one.
//
//   R1 five template columns gone at the host => dry-run 422 TARGET_SCHEMA_INCOMPLETE, details name
//      exactly the five, the probe asked under `${tenant}:integration-core` for the action's target
//      object, and the route made zero source reads and zero records calls.
//   R2 nothing missing => 200, and the response data is deep-equal to the same route on an OLD host
//      (no `resolveExistingObjectFieldIds`) — the route-level "byte-identical for an old host" claim.
//   R3 apply: a token minted while complete, columns deleted before apply => apply 422, nothing
//      written; the same apply with the columns back => 200 and a write.
//   R4 the request cannot name the probe input: `targetFieldExistence` in the body => 400, and the
//      host was never asked.
//   R5 a host whose DB read refuses the object scope => 200, identical to the old-host response.
//   R6 a binding whose (staging project, object) the host derives to a DIFFERENT sheet than the bound
//      one => 200, identical to the old-host response, and the DB read about that other sheet never
//      ran (反驳 r1 blocker).
//   R7 the large-BOM lane: expansion PLAN, apply-job START and apply-job RUN each refuse 422 on the
//      stored job's target when the five are gone — before the existing-row read, before a checkpoint
//      job exists, before a chunk writes — and each goes through once the columns are back.
//   R8 a host failure on the DB read => 503 TARGET_SCHEMA_UNAVAILABLE, details = { targetObjectId },
//      no driver text in the response, zero source/records calls.
//   R3 also pins that a refused apply does NOT burn the dry-run token: the SAME token applies once the
//      columns are back.
//   R9 the confirmation-decision RECONCILE route: the five gone => 422, zero source reads, zero records
//      calls and NO audit row - the refusal lands before the intent append and before the ledger sweep.
//  R10 the MVP-PERSIST route: the five gone => 422 before the source read and before any snapshot write.
//      R9/R10 are the two `computeDryRun` entry points the dry-run/apply cases above did not cover; each
//      is calibrated against deleting its own `targetFieldExistence:` line (#5719 终审 non-blocking item).
//  R11 a host whose `getObjectSheetId` answers a Promise (the async-host future) => 503
//      TARGET_SCHEMA_UNAVAILABLE through the route, values-free, and the DB read never ran - not a
//      silent skip of the probe.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const TENANT_ID = 'tenant_1'
const STAGING_PROJECT_ID = `${TENANT_ID}:integration-core`
const OBJECT_ID = 'stockPreparationMain'
const SHEET_ID = 'sheet_stock_configured'
const SOURCE_SYSTEM_ID = 'plm_sql_source'
const TEMPLATE_FIELD_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id)
const MISSING_FIVE = Object.freeze(['componentSourceId', 'parentSourceId', 'path', 'depth', 'lastPlmRefreshRunId'])

const READ_USER = Object.freeze({ id: 'user_read', tenantId: TENANT_ID, permissions: ['integration:read'] })
const ADMIN_USER = Object.freeze({ id: 'user_admin', tenantId: TENANT_ID, roles: ['admin'], permissions: ['integration:admin'] })

const DRY_RUN_ROUTE = '/api/integration/table-actions/:actionId/dry-run'
const APPLY_ROUTE = '/api/integration/table-actions/:actionId/apply'
const ACTION_PARAMS = { actionId: PLM_STOCK_PREPARATION_ACTION_ID }

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function physical(fieldId) {
  return `fld_${fieldId}`
}

function sourceData() {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: 'P-001', Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2' }],
    DN_PDM_PartLibraryInfo: [{ OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1' }],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
}

function createSourceAdapter(data = sourceData()) {
  const calls = []
  return {
    calls,
    adapter: {
      async read(input = {}) {
        calls.push(clone(input))
        const rows = Array.isArray(data[input.object]) ? data[input.object] : []
        const matches = rows.filter((row) =>
          Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
        return { records: matches.map(clone), nextCursor: null, done: true }
      },
    },
  }
}

function createRecordsApi() {
  const rows = []
  const calls = []
  return {
    calls,
    api: {
      async queryRecords(input = {}) {
        calls.push(['queryRecords', clone(input)])
        return rows.filter((row) => row.sheetId === input.sheetId).map(clone)
      },
      async createRecord(input = {}) {
        calls.push(['createRecord', clone(input)])
        const created = { id: `rec_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
        rows.push(created)
        return clone(created)
      },
      async patchRecord(input = {}) {
        calls.push(['patchRecord', clone(input)])
        const row = rows.find((entry) => entry.id === input.recordId)
        row.version += 1
        row.data = { ...row.data, ...(input.changes || {}) }
        return clone(row)
      },
    },
  }
}

/**
 * The host provisioning surface as the route sees it. `missing` is a LIVE set so one mount can play
 * "complete at dry-run, five columns deleted before apply" (R3). `dbRead: false` is the older host.
 *
 * `computedMissing` makes the compute-only `resolveFieldIds` ALSO omit ids. A real compute-only host
 * never omits (it derives an id for every field it is asked about), so this is not a model of
 * production — it is the instrument that lets R2 (old host) and R5 (scope-refused host) SEE a probe
 * that refuses on a non-db verdict: with a complete compute map such a probe would find nothing to
 * refuse and the `db`-only gate would be unobservable through the route. The plan itself never reads
 * this map on these mounts (the action carries an explicit fieldIdMap), so the response cannot move.
 */
function createProvisioning({ dbRead = true, scopeError = null, computedMissing = [], derivedSheetId = SHEET_ID } = {}) {
  const missing = new Set()
  const probeCalls = []
  const derivations = []
  const answer = (fieldIds) => Object.fromEntries(
    (Array.isArray(fieldIds) ? fieldIds : []).filter((id) => !missing.has(id)).map((id) => [id, physical(id)]),
  )
  const provisioning = {
    // Pure derivation, exactly the host's: the sheet id the DB read below keys `meta_fields` on.
    getObjectSheetId(projectId, objectId) {
      derivations.push({ projectId, objectId })
      return derivedSheetId
    },
    async findObjectSheet({ objectId } = {}) {
      return { id: SHEET_ID, baseId: null, name: objectId, description: null }
    },
    async resolveFieldIds({ fieldIds } = {}) {
      return Object.fromEntries(
        (Array.isArray(fieldIds) ? fieldIds : []).filter((id) => !computedMissing.includes(id)).map((id) => [id, physical(id)]),
      )
    },
    async ensureObject() {
      throw new Error('ensureObject must never be called by a plan route')
    },
  }
  if (dbRead) {
    provisioning.resolveExistingObjectFieldIds = async ({ projectId, objectId, fieldIds } = {}) => {
      probeCalls.push({ projectId, objectId, fieldIds: [...fieldIds] })
      if (scopeError) throw scopeError
      return answer(fieldIds)
    }
  }
  return { provisioning, missing, probeCalls, derivations }
}

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
  }
  return service
}

function baseServices(sourceAdapter) {
  return {
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
}

function actionConfig() {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: SOURCE_SYSTEM_ID, kind: 'data-source:sql-readonly' },
    // An EXPLICIT, COMPLETE physical map — the exact shape the shape-only gate is satisfied by, and
    // therefore the exact shape that could not see the incident.
    target: {
      sheetId: SHEET_ID,
      objectId: OBJECT_ID,
      fieldIdMap: Object.fromEntries(TEMPLATE_FIELD_IDS.map((id) => [id, physical(id)])),
    },
  }
}

function mount({ dbRead = true, scopeError = null, computedMissing = [], derivedSheetId = SHEET_ID, extraServices = null } = {}) {
  const routes = new Map()
  const host = createProvisioning({ dbRead, scopeError, computedMissing, derivedSheetId })
  const records = createRecordsApi()
  const source = createSourceAdapter()
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: {
        provisioning: host.provisioning,
        records: records.api,
      },
    },
    storage: Object.assign(new Map(), { durable: true }),
    config: {
      stockPreparationTableActions: [actionConfig()],
      stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [OBJECT_ID] },
    },
  }
  const logLines = []
  httpRoutes.registerIntegrationRoutes({
    context,
    services: { ...baseServices(source.adapter), ...(extraServices || {}) },
    logger: {
      info(message, detail) { logLines.push(['info', message, detail]) },
      warn(message, detail) { logLines.push(['warn', message, detail]) },
      error(message, detail) { logLines.push(['error', message, detail]) },
    },
  })
  return { routes, host, records, source, logLines, context }
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
  try {
    await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  } catch (error) {
    res.statusCode = error && error.status ? error.status : 500
    res.body = { ok: false, error: { code: error && error.code ? error.code : 'THREW', message: error && error.message, details: error && error.details } }
  }
  assert.notEqual(res.body, undefined, `${method} ${routePath} produced a body`)
  return res
}

async function dryRun(routes, { user = READ_USER, body } = {}) {
  return call(routes, 'POST', DRY_RUN_ROUTE, {
    user,
    params: ACTION_PARAMS,
    body: body || { parameters: { projectNo: 'P-001' } },
  })
}

async function apply(routes, dryRunToken) {
  return call(routes, 'POST', APPLY_ROUTE, {
    user: ADMIN_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: 'P-001' }, confirm: { dryRunToken } },
  })
}

/** Response data minus the random token. */
function comparable(data) {
  const { dryRunToken, ...rest } = data
  return { ...clone(rest), dryRunTokenShape: typeof dryRunToken }
}

// ── R1 ────────────────────────────────────────────────────────────────────────────────────────

async function r1MissingColumnsRefuseTheRouteBeforeAnyRead() {
  const harness = mount()
  for (const id of MISSING_FIVE) harness.host.missing.add(id)
  const res = await dryRun(harness.routes)
  assert.equal(res.statusCode, 422, JSON.stringify(res.body))
  assert.equal(res.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
  assert.deepEqual(res.body.error.details.missingFields, [...MISSING_FIVE], 'R1: the route reports exactly the five')
  assert.deepEqual(Object.keys(res.body.error.details).sort(), ['fieldExistenceMode', 'missingFields', 'targetObjectId'])
  assert.equal(res.body.error.details.fieldExistenceMode, 'db')
  const text = JSON.stringify(res.body)
  assert.equal(text.includes('fld_'), false, 'R1: no physical id in the response')
  assert.equal(text.includes(SHEET_ID), false, 'R1: no sheet id in the response')
  assert.equal(harness.host.probeCalls.length, 1, 'R1: exactly one DB read')
  assert.deepEqual(harness.host.derivations, [{ projectId: STAGING_PROJECT_ID, objectId: OBJECT_ID }], 'R1: the probe first derived the sheet the read is about, under the authenticated tenant')
  assert.equal(harness.host.probeCalls[0].projectId, STAGING_PROJECT_ID, 'R1: the probe asked under the authenticated tenant\'s staging project')
  assert.equal(harness.host.probeCalls[0].objectId, OBJECT_ID, 'R1: about the configured target object')
  assert.deepEqual(harness.host.probeCalls[0].fieldIds, TEMPLATE_FIELD_IDS)
  assert.deepEqual(harness.source.calls, [], 'R1: zero source reads')
  assert.deepEqual(harness.records.calls, [], 'R1: zero records calls — nothing was planned')
}

// ── R2 ────────────────────────────────────────────────────────────────────────────────────────

async function r2CompleteHostAndOldHostAnswerIdentically() {
  const probed = mount()
  // The old host's compute-only map omits the five ON PURPOSE (see createProvisioning): a probe that
  // consulted it would refuse. It must not be consulted, and the answer must not move.
  const legacy = mount({ dbRead: false, computedMissing: [...MISSING_FIVE] })
  const a = await dryRun(probed.routes)
  const b = await dryRun(legacy.routes)
  assert.equal(a.statusCode, 200, JSON.stringify(a.body))
  assert.equal(b.statusCode, 200, JSON.stringify(b.body))
  assert.equal(a.body.data.status, 'ready')
  assert.deepEqual(comparable(a.body.data), comparable(b.body.data), 'R2: a complete probed host answers exactly what an old host answers')
  assert.equal(probed.host.probeCalls.length, 1, 'R2: the probe ran once on the db host')
  assert.equal(legacy.host.probeCalls.length, 0)
  assert.deepEqual(probed.logLines, legacy.logLines, 'R2: the probe adds no log line on either host')
  return comparable(b.body.data)
}

// ── R3 ────────────────────────────────────────────────────────────────────────────────────────

async function r3ApplyIsRefusedWhenColumnsVanishAfterTheDryRun() {
  const harness = mount()
  const planned = await dryRun(harness.routes)
  assert.equal(planned.statusCode, 200, JSON.stringify(planned.body))
  assert.ok(planned.body.data.dryRunToken)
  for (const id of MISSING_FIVE) harness.host.missing.add(id)
  const writesBefore = harness.records.calls.filter(([name]) => name !== 'queryRecords').length
  const refused = await apply(harness.routes, planned.body.data.dryRunToken)
  assert.equal(refused.statusCode, 422, JSON.stringify(refused.body))
  assert.equal(refused.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
  assert.deepEqual(refused.body.error.details.missingFields, [...MISSING_FIVE])
  assert.equal(
    harness.records.calls.filter(([name]) => name !== 'queryRecords').length,
    writesBefore,
    'R3: a refused apply writes nothing',
  )
  // Control, and the token half: columns back, the SAME token the refusal did not burn applies.
  harness.host.missing.clear()
  const applied = await apply(harness.routes, planned.body.data.dryRunToken)
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
  assert.ok(harness.records.calls.some(([name]) => name === 'createRecord'), 'R3 control: the complete target is written with the token the refusal left intact')
  // And it was single-use: the same token a second time is refused as consumed.
  const reused = await apply(harness.routes, planned.body.data.dryRunToken)
  assert.equal(reused.statusCode, 409, JSON.stringify(reused.body))
  assert.equal(reused.body.error.code, 'TABLE_ACTION_DRY_RUN_TOKEN_INVALID')
}

// ── R4 ────────────────────────────────────────────────────────────────────────────────────────

async function r4TheRequestCannotNameTheProbeInput() {
  const harness = mount()
  const res = await dryRun(harness.routes, {
    body: {
      parameters: { projectNo: 'P-001' },
      targetFieldExistence: { provisioning: null, projectId: 'someone-else:integration-core' },
    },
  })
  assert.equal(res.statusCode, 400, JSON.stringify(res.body))
  assert.equal(res.body.error.code, 'TABLE_ACTION_REQUEST_INVALID')
  assert.equal(harness.host.probeCalls.length, 0, 'R4: the host was never asked')
  assert.deepEqual(harness.source.calls, [])
}

// ── R5 ────────────────────────────────────────────────────────────────────────────────────────

async function r5ScopeRefusedHostAnswersLikeAnOldHost(legacyData) {
  const error = new Error('object is not in this plugin scope')
  error.name = 'MultitableObjectScopeError'
  // Both maps omit the five: the DB read never answers (scope refusal), and the compute-only fallback
  // omits them so a probe that refused on the degraded verdict would be seen here.
  const harness = mount({ scopeError: error, computedMissing: [...MISSING_FIVE] })
  for (const id of MISSING_FIVE) harness.host.missing.add(id)
  const res = await dryRun(harness.routes)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.deepEqual(comparable(res.body.data), legacyData, 'R5: a scope-refused probe degrades to the old-host answer')
  assert.equal(harness.host.probeCalls.length, 1)
}

// ── R6 ────────────────────────────────────────────────────────────────────────────────────────

async function r6ADivergentBindingIsNotJudgedOnTheDerivedSheet(legacyData) {
  // The host derives (staging project, object) to a sheet that is NOT the bound one; that other sheet
  // is missing the five. The bound sheet is what the plan reads and writes, so no judgement.
  const harness = mount({ derivedSheetId: 'sheet_derived_elsewhere' })
  for (const id of MISSING_FIVE) harness.host.missing.add(id)
  const res = await dryRun(harness.routes)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.deepEqual(comparable(res.body.data), legacyData, 'R6: a divergent binding answers exactly the old-host answer')
  assert.equal(harness.host.probeCalls.length, 0, 'R6: the DB read about the other sheet never ran')
  assert.deepEqual(harness.host.derivations, [{ projectId: STAGING_PROJECT_ID, objectId: OBJECT_ID }], 'R6: the derivation is what decided it')
  assert.deepEqual(harness.logLines, [], 'R6: and nothing was logged about it')
}

// ── R7 the large-BOM lane ─────────────────────────────────────────────────────────────────────

const JOBS_ROUTE = '/api/integration/table-actions/:actionId/large-bom/expansion-jobs'

async function r7TheLargeBomLaneIsProbedAtPlanApprovalAndEveryChunk() {
  const harness = mount()
  const storedKeys = () => [...harness.context.storage.keys()].length
  const writes = () => harness.records.calls.filter(([name]) => name !== 'queryRecords').length
  const started = await call(harness.routes, 'POST', JOBS_ROUTE, {
    user: READ_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: 'P-001' } },
  })
  assert.equal(started.statusCode, 202, JSON.stringify(started.body))
  const jobId = started.body.data.jobId
  const jobParams = { ...ACTION_PARAMS, jobId }
  const expanded = await call(harness.routes, 'POST', `${JOBS_ROUTE}/:jobId/run`, { user: READ_USER, params: jobParams })
  assert.equal(expanded.statusCode, 200, JSON.stringify(expanded.body))

  // PLAN with the five gone => 422, before the existing-row read.
  for (const id of MISSING_FIVE) harness.host.missing.add(id)
  const recordsBefore = harness.records.calls.length
  const refusedPlan = await call(harness.routes, 'POST', `${JOBS_ROUTE}/:jobId/plan`, { user: READ_USER, params: jobParams, body: {} })
  assert.equal(refusedPlan.statusCode, 422, JSON.stringify(refusedPlan.body))
  assert.equal(refusedPlan.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
  assert.deepEqual(refusedPlan.body.error.details.missingFields, [...MISSING_FIVE])
  assert.equal(harness.records.calls.length, recordsBefore, 'R7 plan: the existing-row read never ran')
  harness.host.missing.clear()
  const planned = await call(harness.routes, 'POST', `${JOBS_ROUTE}/:jobId/plan`, { user: READ_USER, params: jobParams, body: {} })
  assert.equal(planned.statusCode, 200, JSON.stringify(planned.body))

  // START (approval) with the five gone => 422, and no checkpoint job came into existence.
  for (const id of MISSING_FIVE) harness.host.missing.add(id)
  const keysBefore = storedKeys()
  const refusedStart = await call(harness.routes, 'POST', `${JOBS_ROUTE}/:jobId/apply-jobs`, {
    user: ADMIN_USER,
    params: jobParams,
    body: { confirm: { acceptManualConfirmHold: true } },
  })
  assert.equal(refusedStart.statusCode, 422, JSON.stringify(refusedStart.body))
  assert.equal(refusedStart.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
  assert.equal(storedKeys(), keysBefore, 'R7 start: no checkpoint apply job was stored')
  harness.host.missing.clear()
  const approved = await call(harness.routes, 'POST', `${JOBS_ROUTE}/:jobId/apply-jobs`, {
    user: ADMIN_USER,
    params: jobParams,
    body: { confirm: { acceptManualConfirmHold: true } },
  })
  assert.equal(approved.statusCode, 202, JSON.stringify(approved.body))
  const applyJobId = approved.body.data.jobId

  // RUN (a chunk) with the five gone => 422, zero writes; columns back => the chunk writes.
  for (const id of MISSING_FIVE) harness.host.missing.add(id)
  const writesBefore = writes()
  const refusedRun = await call(harness.routes, 'POST', `${JOBS_ROUTE}/:jobId/apply-jobs/:applyJobId/run`, {
    user: ADMIN_USER,
    params: { ...jobParams, applyJobId },
  })
  assert.equal(refusedRun.statusCode, 422, JSON.stringify(refusedRun.body))
  assert.equal(refusedRun.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
  assert.deepEqual(refusedRun.body.error.details.missingFields, [...MISSING_FIVE])
  assert.equal(writes(), writesBefore, 'R7 run: a refused chunk writes nothing')
  harness.host.missing.clear()
  const ran = await call(harness.routes, 'POST', `${JOBS_ROUTE}/:jobId/apply-jobs/:applyJobId/run`, {
    user: ADMIN_USER,
    params: { ...jobParams, applyJobId },
  })
  assert.equal(ran.statusCode, 200, JSON.stringify(ran.body))
  assert.ok(harness.records.calls.some(([name]) => name === 'createRecord'), 'R7 control: the chunk wrote once the columns were back')
  // Every refusal on this lane was values-free and about the stored job's target object.
  for (const res of [refusedPlan, refusedStart, refusedRun]) {
    assert.deepEqual(Object.keys(res.body.error.details).sort(), ['fieldExistenceMode', 'missingFields', 'targetObjectId'])
    assert.equal(res.body.error.details.targetObjectId, OBJECT_ID)
    const text = JSON.stringify(res.body)
    assert.equal(text.includes('fld_'), false)
    assert.equal(text.includes(SHEET_ID), false)
  }
}

// ── R8 ────────────────────────────────────────────────────────────────────────────────────────

async function r8AHostFailureIsAValuesFree503() {
  const boom = new Error('connection terminated')
  boom.code = 'ECONNRESET'
  const harness = mount({ scopeError: boom })
  const res = await dryRun(harness.routes)
  assert.equal(res.statusCode, 503, JSON.stringify(res.body))
  assert.equal(res.body.error.code, 'TARGET_SCHEMA_UNAVAILABLE')
  // `sendError` sanitizes details into a null-prototype object; compare keys and value, not prototype.
  assert.deepEqual(Object.keys(res.body.error.details), ['targetObjectId'], 'R8: details carry the object id and nothing else')
  assert.equal(res.body.error.details.targetObjectId, OBJECT_ID)
  const text = JSON.stringify(res.body)
  assert.equal(text.includes('connection terminated'), false, 'R8: no driver text in the response')
  assert.equal(text.includes('ECONNRESET'), false)
  assert.deepEqual(harness.source.calls, [], 'R8: zero source reads')
  assert.deepEqual(harness.records.calls, [], 'R8: zero records calls')
}

// ── R9 the confirmation-decision RECONCILE route ───────────────────────────────────

const RECONCILE_ROUTE = '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile'

/** The two OPTIONAL services reconcile fails closed without (501) before it ever reaches the plan. */
function reconcileServices(auditAppends) {
  return {
    stockPreparationAuditStore: {
      async append(entry) {
        auditAppends.push(clone(entry))
        return { ok: true }
      },
    },
    stockPreparationConfirmationDecisionLease: {
      async acquire() { return { held: true, leaseId: 'lease-1' } },
      async renew() { return { held: true } },
      async release() { return { released: true } },
    },
  }
}

async function routeReconcile(routes) {
  return call(routes, 'POST', RECONCILE_ROUTE, {
    user: ADMIN_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: 'P-001' } },
  })
}

async function r9ReconcileIsRefusedBeforeAnyReadOrLedgerWrite() {
  const auditAppends = []
  const harness = mount({ extraServices: reconcileServices(auditAppends) })
  for (const id of MISSING_FIVE) harness.host.missing.add(id)
  const res = await routeReconcile(harness.routes)
  assert.equal(res.statusCode, 422, JSON.stringify(res.body))
  assert.equal(res.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
  assert.deepEqual(res.body.error.details.missingFields, [...MISSING_FIVE], 'R9: the route reports exactly the five')
  assert.deepEqual(Object.keys(res.body.error.details).sort(), ['fieldExistenceMode', 'missingFields', 'targetObjectId'])
  assert.equal(res.body.error.details.fieldExistenceMode, 'db')
  assert.equal(res.body.error.details.targetObjectId, OBJECT_ID)
  const text = JSON.stringify(res.body)
  assert.equal(text.includes('fld_'), false, 'R9: no physical id in the response')
  assert.equal(text.includes(SHEET_ID), false, 'R9: no sheet id in the response')
  assert.equal(harness.host.probeCalls.length, 1, 'R9: exactly one DB read')
  assert.deepEqual(
    harness.host.derivations,
    [{ projectId: STAGING_PROJECT_ID, objectId: OBJECT_ID }],
    'R9: the probe derived the sheet the read is about, under the authenticated tenant',
  )
  assert.equal(harness.host.probeCalls[0].projectId, STAGING_PROJECT_ID, 'R9: asked under the authenticated tenant\'s staging project')
  assert.equal(harness.host.probeCalls[0].objectId, OBJECT_ID)
  assert.deepEqual(harness.host.probeCalls[0].fieldIds, TEMPLATE_FIELD_IDS)
  assert.deepEqual(harness.source.calls, [], 'R9: zero source reads')
  assert.deepEqual(harness.records.calls, [], 'R9: zero records calls — nothing was planned')
  assert.deepEqual(auditAppends, [], 'R9: the refusal lands before the intent audit row')

  // Control: the SAME mount with the columns back is not refused by the probe and reaches the source
  // — so the 422 above is this probe\'s doing, not some other refusal on the way in.
  harness.host.missing.clear()
  const through = await routeReconcile(harness.routes)
  assert.notEqual(
    through.body.error && through.body.error.code,
    'TARGET_SCHEMA_INCOMPLETE',
    `R9 control: a complete target is not refused by the probe (${JSON.stringify(through.body)})`,
  )
  assert.ok(harness.source.calls.length > 0, 'R9 control: the complete target plans off the source')
  assert.equal(auditAppends.length, 1, 'R9 control: and the intent row the refusal withheld is appended')
}

// ── R10 the MVP-PERSIST route ──────────────────────────────────────────────────

const MVP_PERSIST_ROUTE = '/api/integration/table-actions/:actionId/mvp-persist'
const MVP_PERSIST_FLAG = 'MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED'

async function routeMvpPersist(routes) {
  return call(routes, 'POST', MVP_PERSIST_ROUTE, {
    user: ADMIN_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: 'P-001' } },
  })
}

async function r10MvpPersistIsRefusedBeforeAnySourceReadOrSnapshotWrite() {
  const previous = process.env[MVP_PERSIST_FLAG]
  process.env[MVP_PERSIST_FLAG] = 'true'
  try {
    const harness = mount()
    for (const id of MISSING_FIVE) harness.host.missing.add(id)
    const res = await routeMvpPersist(harness.routes)
    assert.equal(res.statusCode, 422, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
    assert.deepEqual(res.body.error.details.missingFields, [...MISSING_FIVE], 'R10: the route reports exactly the five')
    assert.deepEqual(Object.keys(res.body.error.details).sort(), ['fieldExistenceMode', 'missingFields', 'targetObjectId'])
    assert.equal(res.body.error.details.fieldExistenceMode, 'db')
    assert.equal(res.body.error.details.targetObjectId, OBJECT_ID)
    const text = JSON.stringify(res.body)
    assert.equal(text.includes('fld_'), false, 'R10: no physical id in the response')
    assert.equal(text.includes(SHEET_ID), false, 'R10: no sheet id in the response')
    assert.equal(harness.host.probeCalls.length, 1, 'R10: exactly one DB read')
    assert.deepEqual(
      harness.host.derivations,
      [{ projectId: STAGING_PROJECT_ID, objectId: OBJECT_ID }],
      'R10: the probe derived the sheet the read is about, under the authenticated tenant',
    )
    assert.equal(harness.host.probeCalls[0].projectId, STAGING_PROJECT_ID, 'R10: asked under the authenticated tenant\'s staging project')
    assert.equal(harness.host.probeCalls[0].objectId, OBJECT_ID)
    assert.deepEqual(harness.host.probeCalls[0].fieldIds, TEMPLATE_FIELD_IDS)
    assert.deepEqual(harness.source.calls, [], 'R10: zero source reads')
    assert.deepEqual(harness.records.calls, [], 'R10: zero records calls — the snapshot committer was never reached')

    // Control, same shape as R9\'s: with the columns back the probe does not refuse and the route
    // goes on to read the source (what it does with the snapshot afterwards is not this suite\'s claim).
    harness.host.missing.clear()
    const through = await routeMvpPersist(harness.routes)
    assert.notEqual(
      through.body.error && through.body.error.code,
      'TARGET_SCHEMA_INCOMPLETE',
      `R10 control: a complete target is not refused by the probe (${JSON.stringify(through.body)})`,
    )
    assert.ok(harness.source.calls.length > 0, 'R10 control: the complete target plans off the source')
  } finally {
    if (previous === undefined) delete process.env[MVP_PERSIST_FLAG]
    else process.env[MVP_PERSIST_FLAG] = previous
  }
}

// ── R11 a derivation that is not a string ──────────────────────────────────────────

// The day a host makes `getObjectSheetId` async, its Promise used to normalise to an empty id and the
// sheet-identity gate (R6) read that as "some other sheet": every plan on that install silently stopped
// being probed. Through the route that is now the same values-free 503 R8 pins, and the DB read the
// probe could not prove was about the bound sheet still never runs.
async function r11ANonStringDerivationIsAValuesFree503() {
  const harness = mount({ derivedSheetId: Promise.resolve(SHEET_ID) })
  for (const id of MISSING_FIVE) harness.host.missing.add(id)
  const res = await dryRun(harness.routes)
  assert.equal(res.statusCode, 503, JSON.stringify(res.body))
  assert.equal(res.body.error.code, 'TARGET_SCHEMA_UNAVAILABLE')
  assert.deepEqual(Object.keys(res.body.error.details), ['targetObjectId'], 'R11: details carry the object id and nothing else')
  assert.equal(res.body.error.details.targetObjectId, OBJECT_ID)
  const text = JSON.stringify(res.body)
  assert.equal(text.includes(SHEET_ID), false, 'R11: no sheet id in the response')
  assert.equal(text.includes('getObjectSheetId'), false, 'R11: the contract message stays on the server log')
  assert.equal(harness.host.probeCalls.length, 0, 'R11: the DB read never ran')
  assert.deepEqual(harness.host.derivations, [{ projectId: STAGING_PROJECT_ID, objectId: OBJECT_ID }], 'R11: the derivation is what decided it')
  assert.deepEqual(harness.source.calls, [], 'R11: zero source reads')
  assert.deepEqual(harness.records.calls, [], 'R11: zero records calls')
}

async function main() {
  await r1MissingColumnsRefuseTheRouteBeforeAnyRead()
  const legacyData = await r2CompleteHostAndOldHostAnswerIdentically()
  await r3ApplyIsRefusedWhenColumnsVanishAfterTheDryRun()
  await r4TheRequestCannotNameTheProbeInput()
  await r5ScopeRefusedHostAnswersLikeAnOldHost(legacyData)
  await r6ADivergentBindingIsNotJudgedOnTheDerivedSheet(legacyData)
  await r7TheLargeBomLaneIsProbedAtPlanApprovalAndEveryChunk()
  await r8AHostFailureIsAValuesFree503()
  await r9ReconcileIsRefusedBeforeAnyReadOrLedgerWrite()
  await r10MvpPersistIsRefusedBeforeAnySourceReadOrSnapshotWrite()
  await r11ANonStringDerivationIsAValuesFree503()
  console.log('stock-preparation-dry-run-target-field-probe-routes tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
