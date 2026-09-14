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
function createProvisioning({ dbRead = true, scopeError = null, computedMissing = [] } = {}) {
  const missing = new Set()
  const probeCalls = []
  const answer = (fieldIds) => Object.fromEntries(
    (Array.isArray(fieldIds) ? fieldIds : []).filter((id) => !missing.has(id)).map((id) => [id, physical(id)]),
  )
  const provisioning = {
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
  return { provisioning, missing, probeCalls }
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

function mount({ dbRead = true, scopeError = null, computedMissing = [] } = {}) {
  const routes = new Map()
  const host = createProvisioning({ dbRead, scopeError, computedMissing })
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
    services: baseServices(source.adapter),
    logger: {
      info(message, detail) { logLines.push(['info', message, detail]) },
      warn(message, detail) { logLines.push(['warn', message, detail]) },
      error(message, detail) { logLines.push(['error', message, detail]) },
    },
  })
  return { routes, host, records, source, logLines }
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
  // Control: columns back, fresh token, the write goes through.
  harness.host.missing.clear()
  const replanned = await dryRun(harness.routes)
  assert.equal(replanned.statusCode, 200, JSON.stringify(replanned.body))
  const applied = await apply(harness.routes, replanned.body.data.dryRunToken)
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
  assert.ok(harness.records.calls.some(([name]) => name === 'createRecord'), 'R3 control: the complete target is written')
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

async function main() {
  await r1MissingColumnsRefuseTheRouteBeforeAnyRead()
  const legacyData = await r2CompleteHostAndOldHostAnswerIdentically()
  await r3ApplyIsRefusedWhenColumnsVanishAfterTheDryRun()
  await r4TheRequestCannotNameTheProbeInput()
  await r5ScopeRefusedHostAnswersLikeAnOldHost(legacyData)
  console.log('stock-preparation-dry-run-target-field-probe-routes tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
