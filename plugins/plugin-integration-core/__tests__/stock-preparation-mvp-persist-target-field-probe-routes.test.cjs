'use strict'

// MVP 快照表字段存在性探针 — THROUGH THE REAL ROUTE TABLE.
//
// The unit suite (stock-preparation-sync-run-persist.test.cjs, cases (i-*)) proves the probe inside
// `persistStockPreparationSyncRun`. This one proves the WIRING through
// `POST /table-actions/:actionId/mvp-persist`: that the probe judges the FOUR MVP snapshot tables
// under the AUTHENTICATED tenant's staging project (the `targetProjectId` the route already derives),
// that the CANONICAL probe #5719 added does not cover them (the same request passes #5719's probe and
// is refused by this one), that a request cannot name the probe input, and that a host without the
// DB-backed read gets a route response identical to the pre-probe one.
//
//   R1 five snapshot-LINE columns gone at the host, canonical target complete => 422
//      TARGET_SCHEMA_INCOMPLETE naming the LINE object and exactly the five; the response carries no
//      sheet id; the internal write sink saw ZERO writes and the unit-of-work never opened; the probe
//      asked under `${tenant}:integration-core` for each MVP table (after the canonical probe passed).
//   R2 nothing missing => 201, and the response body is deep-equal to the same route on an OLD host
//      (no `resolveExistingObjectFieldIds`) — the route-level "byte-identical for an old host" claim.
//   R3 the request cannot name the probe input: `projectId` / `targetProjectId` in the body => 400
//      STOCK_PREPARATION_TABLE_ACTION_MVP_PERSIST_STEERING_NOT_ALLOWED, `targetFieldExistence` => 400
//      TABLE_ACTION_REQUEST_INVALID (the body allowlist), and in every arm the host was never asked.
//   R4 a host whose DB read refuses the object scope for the MVP tables => 201, identical to the
//      old-host response (degraded, not refused).
//   R5 a host failure on the MVP DB read => 503 TARGET_SCHEMA_UNAVAILABLE, details = { targetObjectId },
//      no driver text in the response, zero internal writes.
//   R6 the probe's project is the authenticated tenant's staging project on EVERY call — never the
//      business `stockprep_<digest>` project id and never a request value.
//
// MUTATIONS this suite is calibrated against (in-memory, never on disk): M1 probe loop removed => R1
// red; M2 capability gate removed => R2's old-host arm red (extra compute-only calls on an old host); M3 details
// carry a sheet id => R1 red; M4 host failure rethrown raw => R5 red.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  RUN_OBJECT_ID,
  PROJECT_OBJECT_ID,
} = require(path.join(LIB, 'stock-preparation-sync-run-persist.cjs'))

const MVP_PERSIST_GATE = 'MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED'
const TENANT_ID = 'tenant_1'
const STAGING_PROJECT_ID = `${TENANT_ID}:integration-core`
const CANONICAL_OBJECT_ID = 'stockPreparationMain'
// The canonical binding names the sheet the host derives for (staging, canonical object) so #5719's
// sheet-identity gate lets ITS probe run — the point of R1 is that it runs, passes, and does not cover
// the snapshot tables.
const CANONICAL_SHEET_ID = `sheet_${CANONICAL_OBJECT_ID}`
const SOURCE_SYSTEM_ID = 'plm_sql_source'
const TEMPLATE_FIELD_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id)
const MISSING_LINE_FIVE = Object.freeze(['pathKey', 'designQty', 'designUnit', 'totalQuantity', 'sourceFingerprint'])
const MVP_OBJECT_IDS = Object.freeze([BATCH_OBJECT_ID, LINE_OBJECT_ID, RUN_OBJECT_ID, PROJECT_OBJECT_ID])

const ADMIN_USER = Object.freeze({ id: 'user_admin', tenantId: TENANT_ID, roles: ['admin'], permissions: ['integration:admin'] })

const MVP_PERSIST_ROUTE = '/api/integration/table-actions/:actionId/mvp-persist'
const ACTION_PARAMS = { actionId: PLM_STOCK_PREPARATION_ACTION_ID }

function clone(value) {
  return JSON.parse(JSON.stringify(value))
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

// The internal MVP write sink as the route sees it: an in-memory records API with the atomic
// unit-of-work the persist module requires. `writes` is the sink; `unitOfWorkCalls` proves whether
// the host transaction ever opened.
function createRecordsApi() {
  const sheets = new Map()
  const writes = []
  const queries = []
  const unitOfWorkCalls = []
  let seq = 0
  const sheetFor = (sheetId) => {
    if (!sheets.has(sheetId)) sheets.set(sheetId, new Map())
    return sheets.get(sheetId)
  }
  const api = {
    async queryRecords({ sheetId, filters } = {}) {
      queries.push({ sheetId })
      const predicate = filters && typeof filters === 'object' ? filters : {}
      return [...sheetFor(sheetId).values()]
        .filter((row) => Object.entries(predicate).every(([key, value]) => row.data[key] === value))
        .map((row) => ({ id: row.id, sheetId: row.sheetId, version: 1, data: { ...row.data } }))
    },
    async createRecord({ sheetId, data } = {}) {
      seq += 1
      const id = `rec_${seq}`
      sheetFor(sheetId).set(id, { id, sheetId, data: { ...data } })
      writes.push({ op: 'create', sheetId, data: { ...data } })
      return { id, sheetId, version: 1, data: { ...data } }
    },
    async patchRecord({ sheetId, recordId, changes } = {}) {
      const existing = sheetFor(sheetId).get(recordId)
      if (!existing) throw new Error(`patchRecord: unknown record ${recordId}`)
      const data = { ...existing.data, ...(changes || {}) }
      sheetFor(sheetId).set(recordId, { id: recordId, sheetId, data })
      writes.push({ op: 'patch', sheetId, data: { ...changes } })
      return { id: recordId, sheetId, version: 2, data: { ...data } }
    },
    async runStockPreparationPersistUnitOfWork(input, operation) {
      unitOfWorkCalls.push(clone(input))
      return operation(api)
    },
  }
  return { api, writes, queries, unitOfWorkCalls }
}

/**
 * The host provisioning surface as the route sees it. Every object resolves to `sheet_<objectId>`,
 * and `getObjectSheetId` derives the same — so #5719's canonical probe judges the bound canonical
 * sheet and passes (its map is complete), while the MVP tables' verdict is per objectId through
 * `missing`. `dbRead: false` is the older host. `scopeErrorFor` / `dbReadErrorFor` name the objects
 * whose DB read throws, so a failure can be aimed at the MVP tables without tripping the canonical
 * probe first.
 */
function createProvisioning({ dbRead = true, scopeErrorFor = new Set(), dbReadError = null, dbReadErrorFor = new Set() } = {}) {
  const missing = new Map() // objectId -> Set(fieldId)
  const probeCalls = []
  const computeCalls = [] // compute-only resolveFieldIds — the pre-probe trace an old host must keep
  const identity = (fieldIds) => Object.fromEntries((Array.isArray(fieldIds) ? fieldIds : []).map((id) => [id, id]))
  const provisioning = {
    getObjectSheetId(_projectId, objectId) {
      return `sheet_${objectId}`
    },
    async findObjectSheet({ objectId } = {}) {
      return { id: `sheet_${objectId}`, baseId: null, name: objectId, description: null }
    },
    async resolveFieldIds({ objectId, fieldIds } = {}) {
      computeCalls.push({ objectId })
      return identity(fieldIds)
    },
    async ensureObject() {
      throw new Error('ensureObject must never be called by the persist route')
    },
  }
  if (dbRead) {
    provisioning.resolveExistingObjectFieldIds = async ({ projectId, objectId, fieldIds } = {}) => {
      probeCalls.push({ projectId, objectId, fieldIds: [...fieldIds] })
      if (dbReadErrorFor.has(objectId)) throw dbReadError
      if (scopeErrorFor.has(objectId)) {
        const error = new Error('object is not in this plugin scope')
        error.name = 'MultitableObjectScopeError'
        throw error
      }
      const gone = missing.get(objectId) || new Set()
      return Object.fromEntries((Array.isArray(fieldIds) ? fieldIds : []).filter((id) => !gone.has(id)).map((id) => [id, id]))
    }
  }
  return {
    provisioning,
    probeCalls,
    computeCalls,
    remove(objectId, fieldIds) {
      missing.set(objectId, new Set(fieldIds))
    },
    restore() {
      missing.clear()
    },
  }
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
    target: {
      sheetId: CANONICAL_SHEET_ID,
      objectId: CANONICAL_OBJECT_ID,
      fieldIdMap: Object.fromEntries(TEMPLATE_FIELD_IDS.map((id) => [id, id])),
    },
  }
}

function mount(hostOptions = {}) {
  const routes = new Map()
  const host = createProvisioning(hostOptions)
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
    },
  }
  const logLines = []
  httpRoutes.registerIntegrationRoutes({
    context,
    services: baseServices(source.adapter),
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

async function persist(routes, { body } = {}) {
  return call(routes, 'POST', MVP_PERSIST_ROUTE, {
    user: ADMIN_USER,
    params: ACTION_PARAMS,
    body: body || { parameters: { projectNo: 'P-001' } },
  })
}

function assertProbeUnderStagingProject(host) {
  assert.ok(host.probeCalls.length > 0, 'the probe ran')
  for (const probe of host.probeCalls) {
    assert.equal(probe.projectId, STAGING_PROJECT_ID, 'every probe call is under the authenticated tenant\'s staging project')
    assert.equal(probe.projectId.startsWith('stockprep_'), false, 'never the business project id')
  }
}

// ── R1 ────────────────────────────────────────────────────────────────────────────────────────

async function r1MissingSnapshotLineColumnsRefuseTheRouteBeforeAnyWrite() {
  const harness = mount()
  harness.host.remove(LINE_OBJECT_ID, MISSING_LINE_FIVE)
  const res = await persist(harness.routes)
  assert.equal(res.statusCode, 422, JSON.stringify(res.body))
  assert.equal(res.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
  assert.deepEqual(Object.keys(res.body.error.details).sort(), ['fieldExistenceMode', 'missingFields', 'targetObjectId'], 'R1: exactly the three keys, on the RESPONSE body')
  assert.equal(res.body.error.details.targetObjectId, LINE_OBJECT_ID, 'R1: the snapshot LINE table, not the canonical target')
  assert.deepEqual(res.body.error.details.missingFields, [...MISSING_LINE_FIVE], 'R1: exactly the five')
  assert.equal(res.body.error.details.fieldExistenceMode, 'db')
  const text = JSON.stringify(res.body)
  assert.equal(text.includes('sheet_'), false, 'R1: no sheet id in the response')
  assert.equal(text.includes('P-001'), false, 'R1: no project value in the response')
  assert.deepEqual(harness.records.writes, [], 'R1: zero internal writes')
  assert.deepEqual(harness.records.unitOfWorkCalls, [], 'R1: the host unit-of-work never opened')
  // The canonical plan's existing-row read on the CANONICAL sheet is pre-probe behaviour and
  // unchanged; what must be zero is any read of the four snapshot tables (the replay read).
  assert.deepEqual(harness.records.queries.filter((query) => query.sheetId !== CANONICAL_SHEET_ID), [], 'R1: zero reads of the MVP snapshot tables')
  // THE GAP, on one request: #5719's canonical probe ran first and passed (the canonical map is
  // complete); only this probe saw the snapshot table. Batch is judged before line; run/project are
  // never reached.
  assert.deepEqual(
    harness.host.probeCalls.map((probe) => probe.objectId),
    [CANONICAL_OBJECT_ID, BATCH_OBJECT_ID, LINE_OBJECT_ID],
    'R1: canonical (passed) then the MVP tables in write order up to the refused one',
  )
  assertProbeUnderStagingProject(harness.host)
  // The source WAS read: the persist plan is recomputed from the source before the write path is
  // entered, exactly as before. The guarantee here is zero WRITES, not zero source reads.
  assert.ok(harness.source.calls.length > 0, 'R1: the plan was recomputed from the source (unchanged)')
}

// ── R2 ────────────────────────────────────────────────────────────────────────────────────────

async function r2CompleteHostAndOldHostAnswerIdentically() {
  const probed = mount()
  const legacy = mount({ dbRead: false })
  const a = await persist(probed.routes)
  const b = await persist(legacy.routes)
  assert.equal(a.statusCode, 201, JSON.stringify(a.body))
  assert.equal(b.statusCode, 201, JSON.stringify(b.body))
  assert.equal(a.body.data.status, 'created')
  assert.deepEqual(a.body, b.body, 'R2: a complete probed host answers exactly what an old host answers')
  assert.deepEqual(probed.host.probeCalls.map((probe) => probe.objectId), [CANONICAL_OBJECT_ID, ...MVP_OBJECT_IDS], 'R2: canonical then all four MVP tables, once each')
  assert.equal(legacy.host.probeCalls.length, 0, 'R2: an old host is never asked')
  // The old host's compute-only trace is exactly the four resolutions resolveScopedTarget always made
  // (the canonical action carries an explicit fieldIdMap): a probe that consulted the compute map on
  // an old host would add four more.
  assert.deepEqual(legacy.host.computeCalls.map((c) => c.objectId), [...MVP_OBJECT_IDS], 'R2: the old-host provisioning trace is the pre-probe trace')
  assert.deepEqual(probed.host.computeCalls.map((c) => c.objectId), [...MVP_OBJECT_IDS], 'R2: the db host adds no compute-only call either')
  assert.deepEqual(probed.logLines, legacy.logLines, 'R2: the probe adds no log line on either host')
  // The sinks agree too, modulo the project row's wall-clock stamp.
  const comparableWrites = (writes) => writes.map((write) => {
    const { lastSyncedAt, ...data } = write.data
    return { op: write.op, sheetId: write.sheetId, data, stamped: typeof lastSyncedAt }
  })
  assert.deepEqual(comparableWrites(probed.records.writes), comparableWrites(legacy.records.writes), 'R2: identical writes')
  assertProbeUnderStagingProject(probed.host)
  return b.body
}

// ── R3 ────────────────────────────────────────────────────────────────────────────────────────

async function r3TheRequestCannotNameTheProbeInput() {
  // Two closed doors, both BEFORE any host call: the no-steering guard names the known steering
  // keys (projectId / targetProjectId => STEERING_NOT_ALLOWED); every other unknown body key falls to
  // the body allowlist (=> TABLE_ACTION_REQUEST_INVALID). Neither can reach the probe.
  for (const [label, extra, code] of [
    ['targetFieldExistence', { targetFieldExistence: { provisioning: null, projectId: 'someone-else:integration-core' } }, 'TABLE_ACTION_REQUEST_INVALID'],
    ['projectId', { projectId: 'someone-else:integration-core' }, 'STOCK_PREPARATION_TABLE_ACTION_MVP_PERSIST_STEERING_NOT_ALLOWED'],
    ['targetProjectId', { targetProjectId: 'someone-else:integration-core' }, 'STOCK_PREPARATION_TABLE_ACTION_MVP_PERSIST_STEERING_NOT_ALLOWED'],
  ]) {
    const harness = mount()
    harness.host.remove(LINE_OBJECT_ID, MISSING_LINE_FIVE)
    const res = await persist(harness.routes, { body: { parameters: { projectNo: 'P-001' }, ...extra } })
    assert.equal(res.statusCode, 400, `${label}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.error.code, code, label)
    assert.equal(harness.host.probeCalls.length, 0, `R3 ${label}: the host was never asked`)
    assert.deepEqual(harness.source.calls, [], `R3 ${label}: zero source reads`)
    assert.deepEqual(harness.records.writes, [], `R3 ${label}: zero writes`)
  }
}

// ── R4 ────────────────────────────────────────────────────────────────────────────────────────

async function r4ScopeRefusedHostAnswersLikeAnOldHost(legacyBody) {
  const harness = mount({ scopeErrorFor: new Set(MVP_OBJECT_IDS) })
  harness.host.remove(LINE_OBJECT_ID, MISSING_LINE_FIVE) // never answered — the read refuses first
  const res = await persist(harness.routes)
  assert.equal(res.statusCode, 201, JSON.stringify(res.body))
  assert.deepEqual(res.body, legacyBody, 'R4: a scope-refused probe degrades to the old-host answer')
  assert.deepEqual(harness.host.probeCalls.map((probe) => probe.objectId), [CANONICAL_OBJECT_ID, ...MVP_OBJECT_IDS], 'R4: the DB read was attempted for each table')
}

// ── R5 ────────────────────────────────────────────────────────────────────────────────────────

async function r5AHostFailureIsAValuesFree503() {
  const boom = new Error('connection terminated unexpectedly')
  boom.code = 'ECONNRESET'
  const harness = mount({ dbReadError: boom, dbReadErrorFor: new Set([LINE_OBJECT_ID]) })
  const res = await persist(harness.routes)
  assert.equal(res.statusCode, 503, JSON.stringify(res.body))
  assert.equal(res.body.error.code, 'TARGET_SCHEMA_UNAVAILABLE')
  // `sendError` sanitizes details into a null-prototype object; compare keys and value, not prototype.
  assert.deepEqual(Object.keys(res.body.error.details), ['targetObjectId'], 'R5: details carry the object id and nothing else')
  assert.equal(res.body.error.details.targetObjectId, LINE_OBJECT_ID)
  const text = JSON.stringify(res.body)
  assert.equal(text.includes('connection terminated'), false, 'R5: no driver text in the response')
  assert.equal(text.includes('ECONNRESET'), false)
  assert.deepEqual(harness.records.writes, [], 'R5: zero internal writes')
  assert.deepEqual(harness.records.unitOfWorkCalls, [], 'R5: the unit-of-work never opened')
}

// ── R6 ────────────────────────────────────────────────────────────────────────────────────────

async function r6TheProbeProjectIsTheAuthenticatedTenantsStagingProject() {
  const other = Object.freeze({ ...ADMIN_USER, id: 'user_admin_2', tenantId: 'tenant_2' })
  const harness = mount()
  harness.host.remove(LINE_OBJECT_ID, MISSING_LINE_FIVE)
  const res = await call(harness.routes, 'POST', MVP_PERSIST_ROUTE, {
    user: other,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: 'P-001' } },
  })
  assert.equal(res.statusCode, 422, JSON.stringify(res.body))
  assert.ok(harness.host.probeCalls.length > 0)
  for (const probe of harness.host.probeCalls) {
    assert.equal(probe.projectId, 'tenant_2:integration-core', 'R6: the probe project follows the AUTHENTICATED tenant')
  }
}

async function main() {
  const previousGate = process.env[MVP_PERSIST_GATE]
  process.env[MVP_PERSIST_GATE] = 'true'
  try {
    await r1MissingSnapshotLineColumnsRefuseTheRouteBeforeAnyWrite()
    const legacyBody = await r2CompleteHostAndOldHostAnswerIdentically()
    await r3TheRequestCannotNameTheProbeInput()
    await r4ScopeRefusedHostAnswersLikeAnOldHost(legacyBody)
    await r5AHostFailureIsAValuesFree503()
    await r6TheProbeProjectIsTheAuthenticatedTenantsStagingProject()
  } finally {
    if (previousGate === undefined) delete process.env[MVP_PERSIST_GATE]
    else process.env[MVP_PERSIST_GATE] = previousGate
  }
  console.log('stock-preparation-mvp-persist-target-field-probe-routes tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
