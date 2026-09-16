'use strict'

// MVP 快照表补列动词挂路由 — THROUGH THE REAL ROUTE TABLE (#5721 终审, 规格 R).
//
// The unit suite (stock-preparation-mvp-provisioning.test.cjs, cases (a)-(i)) proves the verb
// `repairStockPreparationMvpTargets`. Before this PR that verb had NO production caller: no route, no
// script — so the 422 TARGET_SCHEMA_INCOMPLETE the mvp-persist probe (#5721) raises pointed at a dead
// end. This suite proves the WIRING through `POST /api/integration/stock-preparation/mvp/repair`:
// that the route reaches the verb under the AUTHENTICATED tenant's staging project, that it submits to
// the host EXACTLY the probe's missing set and nothing else, that it never touches an existing column
// or a row, that the request cannot steer it, and that an old host is refused — never answered 200.
//
//   R1 the snapshot-LINE table is short FIVE template columns => 200; the host received ONE
//      ensureMissingObjectFields call whose `fields` are exactly those five logical ids (same 口径 as
//      the #5721 probe: resolveFieldExistence + missingLogicalFields, computed here over the same host
//      before the call); the response names the objectId and the five ids, fieldExistenceMode 'db';
//      ensureObject / patchObjectFieldProperty / deleteObjectField were never called; the records API
//      was never touched; the whole sweep ran inside ONE runObjectFieldsRepairTransaction; the response
//      carries no sheet id, no physical field id, no project id.
//   R2 nothing missing (all 9 tables) => 200, every table `mvp_already_ready` with addedFieldCount 0
//      and addedFieldIds [] — and ZERO ensureMissingObjectFields calls (not "a call with an empty
//      list"); zero ensureObject/patch/delete; zero record writes.
//   R3 idempotence: R1's harness called a second time => 200, 0 added, the host saw no second write.
//   R4 non-admin (integration:write) => 403 FORBIDDEN with ZERO host calls of any kind; no principal
//      => 401.
//   R5 the request cannot steer: body tenantId / body projectId / query tenantId / query projectId /
//      params projectId => 400 STOCK_PREPARATION_MVP_REPAIR_STEERING_NOT_ALLOWED; body baseId => 400
//      STOCK_PREPARATION_BASE_ID_NOT_ALLOWED (the family's own code); a caller-supplied `fields` list
//      => 400 STOCK_PREPARATION_MVP_REPAIR_REQUEST_INVALID (closed allowlist). In every arm the host
//      was never asked and nothing was written.
//   R6 an OLD host (no runObjectFieldsRepairTransaction) => 501 MVP_REPAIR_API_UNAVAILABLE, details
//      name the required method, zero writes, zero transactions, values-free.
//   R7 the repaired project is the AUTHENTICATED tenant's staging project on every host call, under a
//      second tenant principal too — never a request value.
//   R8 the verb's own refusals pass through with their status: an unknown objectId => 422
//      MVP_TARGET_OBJECT_ID_INVALID (zero writes, zero transactions); an absent table => 409
//      MVP_REPAIR_TARGET_ABSENT (zero writes).
//   R9 the route table names the route exactly once, as POST, on the handler this suite exercised.
//   R10 (反驳 r1) an UNREGISTERED objectId — the host's tx surface throws its status-less
//      MultitableObjectScopeError whose message names `${projectId}/${objectId}` (the 222 pre-check
//      state) => 409 MVP_REPAIR_SCOPE_UNAVAILABLE, details {objectId, hostMethod}, response AND every
//      log line values-free (no tenant id, no project id), zero additive writes, the one transaction
//      rolled back; a two-table sweep where the second table is unregistered rolls back the first
//      table's already-submitted write too (atomic) and reports the same 409.
//
//   (反驳 r1, folded into R5) `workspaceId` is no longer an accepted-and-ignored key => 400; an
//   objectIds key that names nothing ([] / [123, null] / '') => 400 with zero host calls — it must not
//   widen into "all 9 tables".
//
// MUTATIONS this suite is calibrated against (in-memory, never on disk — a preload swaps the module
// source at _compile time): M1 `requireAccess(req, 'admin')` dropped from the handler => R4 red;
// M2 the normalizer reads projectId from the request (steering wall removed + ensure's allowlist +
// `input.projectId`) => R5 and R7 red; M3 the handler calls ensureStockPreparationMvpTargets instead
// of the repair verb => R1 red (the route degenerates into the dead end: no additive write reaches
// the host); M4 the handler answers 200 on an old host => R6 red; M5 the 501 re-cast dropped (verb's
// 503 passes through) => R6 red; M7 the verb's scope re-cast dropped (the raw host error escapes) =>
// R10 red; M8 the empty-objectIds guard dropped => R5 red.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { STOCK_PREPARATION_MVP_TABLE_TEMPLATES } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  resolveFieldExistence,
  __internals: { templateFieldIds, missingLogicalFields },
} = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))
const { LINE_OBJECT_ID } = require(path.join(LIB, 'stock-preparation-sync-run-persist.cjs'))

const TENANT_ID = 'tenant_1'
const STAGING_PROJECT_ID = `${TENANT_ID}:integration-core`
const ALL_MVP_OBJECT_IDS = Object.freeze(STOCK_PREPARATION_MVP_TABLE_TEMPLATES.map((template) => template.objectId))
const MISSING_LINE_FIVE = Object.freeze(['pathKey', 'designQty', 'designUnit', 'totalQuantity', 'sourceFingerprint'])

const ADMIN_USER = Object.freeze({ id: 'user_admin', tenantId: TENANT_ID, roles: ['admin'], permissions: ['integration:admin'] })
const WRITER_USER = Object.freeze({ id: 'user_writer', tenantId: TENANT_ID, roles: ['member'], permissions: ['integration:write'] })

const REPAIR_ROUTE = '/api/integration/stock-preparation/mvp/repair'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * The host provisioning surface as the route sees it. Every MVP table is present (configurable);
 * `missing` holds, per objectId, the template fields the DB read must NOT resolve. The only additive
 * primitive (`ensureMissingObjectFields`) is recorded and heals the `missing` set; every
 * MUTATING/CREATING primitive (ensureObject / patchObjectFieldProperty / deleteObjectField) is a
 * recording stub that THROWS — reaching one is itself the failure. `withRepairRunner: false` is the
 * older host (no runObjectFieldsRepairTransaction).
 */
// 反驳 r1: the host's OWN error shape for an object this plugin never claimed — no `status`, and a
// message that names the tenant's project id (packages/core-backend/src/multitable/plugin-scope.ts:91-99).
function hostObjectScopeError(projectId, objectId) {
  return Object.assign(
    new Error(`Plugin integration-core cannot claim multitable object ${projectId}/${objectId}; owned by unregistered`),
    { name: 'MultitableObjectScopeError', code: 'MULTITABLE_OBJECT_SCOPE_FORBIDDEN' },
  )
}

function createProvisioning({ withRepairRunner = true, absentObjectIds = [], unregisteredObjectIds = [] } = {}) {
  const missing = new Map() // objectId -> Set(fieldId)
  const absent = new Set(absentObjectIds)
  // 反驳 r1: objectIds with NO plugin_multitable_object_registry row. Mirrors the host exactly
  // (plugin-scope.ts:436-460): the three content methods assert object scope, findObjectSheet is
  // discovery-only and still answers.
  const unregistered = new Set(unregisteredObjectIds)
  const assertScope = (projectId, objectId) => {
    if (unregistered.has(objectId)) throw hostObjectScopeError(projectId, objectId)
  }
  const calls = {
    findObjectSheet: [],
    resolveFieldIds: [],
    resolveExistingObjectFieldIds: [],
    readObjectFieldsContent: [],
    ensureMissingObjectFields: [],
    ensureObject: [],
    patchObjectFieldProperty: [],
    deleteObjectField: [],
    runObjectFieldsRepairTransaction: 0,
    rolledBackTransactions: 0,
  }
  const gone = (objectId) => missing.get(objectId) || new Set()
  const provisioning = {
    async findObjectSheet({ projectId, objectId } = {}) {
      calls.findObjectSheet.push({ projectId, objectId })
      if (absent.has(objectId) || !ALL_MVP_OBJECT_IDS.includes(objectId)) return null
      return { id: `sheet_${objectId}`, baseId: null, name: objectId, description: null }
    },
    // Compute-only derivation (the real host's never omits a field) — what an ENSURE would look at.
    async resolveFieldIds({ projectId, objectId, fieldIds } = {}) {
      calls.resolveFieldIds.push({ projectId, objectId })
      return Object.fromEntries((Array.isArray(fieldIds) ? fieldIds : []).map((id) => [id, `fld_${objectId}_${id}`]))
    },
    async resolveExistingObjectFieldIds({ projectId, objectId, fieldIds } = {}) {
      calls.resolveExistingObjectFieldIds.push({ projectId, objectId, fieldIds: [...fieldIds] })
      assertScope(projectId, objectId)
      const set = gone(objectId)
      return Object.fromEntries((Array.isArray(fieldIds) ? fieldIds : []).filter((id) => !set.has(id)).map((id) => [id, `fld_${objectId}_${id}`]))
    },
    async readObjectFieldsContent({ projectId, objectId, fieldIds } = {}) {
      calls.readObjectFieldsContent.push({ projectId, objectId })
      assertScope(projectId, objectId)
      const set = gone(objectId)
      const out = {}
      for (const id of Array.isArray(fieldIds) ? fieldIds : []) {
        if (!set.has(id)) out[id] = { name: id, type: 'text', property: {}, order: 0 }
      }
      return out
    },
    async ensureMissingObjectFields(input = {}) {
      calls.ensureMissingObjectFields.push(clone(input))
      assertScope(input.projectId, input.objectId)
      const set = gone(input.objectId)
      const addedFieldIds = []
      const skippedExistingFieldIds = []
      for (const field of input.fields || []) {
        const physicalId = `fld_${input.objectId}_${field.id}`
        if (set.has(field.id)) {
          set.delete(field.id)
          addedFieldIds.push(physicalId)
        } else {
          skippedExistingFieldIds.push(physicalId)
        }
      }
      return { addedFieldIds, skippedExistingFieldIds }
    },
    async ensureObject(input = {}) {
      calls.ensureObject.push({ projectId: input.projectId, objectId: input.descriptor && input.descriptor.id })
      throw new Error('ensureObject must never be called by the repair route')
    },
    async patchObjectFieldProperty(input = {}) {
      calls.patchObjectFieldProperty.push({ projectId: input.projectId, objectId: input.objectId, fieldId: input.fieldId })
      throw new Error('patchObjectFieldProperty must never be called by the repair route')
    },
    async deleteObjectField(input = {}) {
      calls.deleteObjectField.push({ projectId: input.projectId, objectId: input.objectId, fieldId: input.fieldId })
      throw new Error('deleteObjectField must never be called by the repair route')
    },
  }
  if (withRepairRunner) {
    provisioning.runObjectFieldsRepairTransaction = async (fn) => {
      calls.runObjectFieldsRepairTransaction += 1
      try {
        return await fn({
          findObjectSheet: (i) => provisioning.findObjectSheet(i),
          resolveExistingObjectFieldIds: (i) => provisioning.resolveExistingObjectFieldIds(i),
          readObjectFieldsContent: (i) => provisioning.readObjectFieldsContent(i),
          ensureMissingObjectFields: (i) => provisioning.ensureMissingObjectFields(i),
        })
      } catch (error) {
        // A throw out of the callback is what the real runner rolls back on.
        calls.rolledBackTransactions += 1
        throw error
      }
    }
  }
  return {
    provisioning,
    calls,
    remove(objectId, fieldIds) {
      missing.set(objectId, new Set(fieldIds))
    },
    /** Every host call that named a project id, whatever the method. */
    projectIdsTouched() {
      const out = []
      for (const key of ['findObjectSheet', 'resolveFieldIds', 'resolveExistingObjectFieldIds', 'readObjectFieldsContent', 'ensureMissingObjectFields', 'ensureObject', 'patchObjectFieldProperty', 'deleteObjectField']) {
        for (const call of calls[key]) if (typeof call.projectId === 'string') out.push(call.projectId)
      }
      return out
    },
    hostCallCount() {
      return calls.findObjectSheet.length + calls.resolveFieldIds.length + calls.resolveExistingObjectFieldIds.length
        + calls.readObjectFieldsContent.length + calls.ensureMissingObjectFields.length + calls.ensureObject.length
        + calls.patchObjectFieldProperty.length + calls.deleteObjectField.length + calls.runObjectFieldsRepairTransaction
    },
  }
}

// The records API as the route sees it: every write is a recording stub that throws. A repair is a
// STRUCTURE verb; a row write reaching this sink is the failure.
function createRecordsApi() {
  const writes = []
  const unitOfWorkCalls = []
  const refuse = (op) => async (input = {}) => {
    writes.push({ op, sheetId: input.sheetId })
    throw new Error(`${op} must never be called by the repair route`)
  }
  const api = {
    async queryRecords() { return [] },
    createRecord: refuse('createRecord'),
    patchRecord: refuse('patchRecord'),
    deleteRecord: refuse('deleteRecord'),
    async runStockPreparationPersistUnitOfWork(input, operation) {
      unitOfWorkCalls.push(clone(input))
      return operation(api)
    },
  }
  return { api, writes, unitOfWorkCalls }
}

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
  }
  return service
}

function baseServices() {
  return {
    externalSystemRegistry: inertService(['upsertExternalSystem', 'getExternalSystem', 'deleteExternalSystem', 'listExternalSystems', 'getExternalSystemForAdapter']),
    adapterRegistry: {
      createAdapter() { throw new Error('unexpected adapter creation') },
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

function mount(hostOptions = {}) {
  const routes = new Map()
  const host = createProvisioning(hostOptions)
  const records = createRecordsApi()
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          const key = `${method.toUpperCase()} ${routePath}`
          assert.equal(routes.has(key), false, `route ${key} registered twice`)
          routes.set(key, handler)
        },
      },
      multitable: {
        provisioning: host.provisioning,
        records: records.api,
      },
    },
    storage: Object.assign(new Map(), { durable: true }),
    config: {},
  }
  const logLines = []
  httpRoutes.registerIntegrationRoutes({
    context,
    services: baseServices(),
    logger: {
      info(message, detail) { logLines.push(['info', message, detail]) },
      warn(message, detail) { logLines.push(['warn', message, detail]) },
      error(message, detail) { logLines.push(['error', message, detail]) },
    },
  })
  return { routes, host, records, logLines, context }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

// 反驳 r1: NO try/catch here. `addRoute` stores registerIntegrationRoutes' wrapper, which turns every
// throw into sendError — so a throw reaching this helper IS a dispatcher regression and fails the test
// instead of being re-shaped into a status the assertions might accept.
async function call(routes, method, routePath, req = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  assert.notEqual(res.body, undefined, `${method} ${routePath} produced a body`)
  return res
}

async function repair(routes, { user = ADMIN_USER, body = {}, query = {}, params = {} } = {}) {
  return call(routes, 'POST', REPAIR_ROUTE, { user, body, query, params })
}

// Sentinels a values-free response must NEVER contain: sheet ids, physical field ids, the project id.
function assertValuesFree(payload, label) {
  const text = JSON.stringify(payload)
  for (const token of ['sheet_', 'fld_', 'physical_', 'integration-core', TENANT_ID]) {
    assert.equal(text.includes(token), false, `${label} must not leak "${token}"`)
  }
}

function assertNoStructureMutationNoRowWrite(harness, label) {
  assert.deepEqual(harness.host.calls.ensureObject, [], `${label}: ensureObject never called`)
  assert.deepEqual(harness.host.calls.patchObjectFieldProperty, [], `${label}: patchObjectFieldProperty never called`)
  assert.deepEqual(harness.host.calls.deleteObjectField, [], `${label}: deleteObjectField never called`)
  assert.deepEqual(harness.records.writes, [], `${label}: zero record writes`)
  assert.deepEqual(harness.records.unitOfWorkCalls, [], `${label}: the records unit-of-work never opened`)
}

function assertZeroHostCalls(harness, label) {
  assert.equal(harness.host.hostCallCount(), 0, `${label}: the host was never asked (${JSON.stringify(harness.host.calls)})`)
  assertNoStructureMutationNoRowWrite(harness, label)
}

/** The #5721 probe's verdict, computed over the SAME host the route is about to use. */
async function probeMissingSet(host, objectId) {
  const template = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((candidate) => candidate.objectId === objectId)
  const verdict = await resolveFieldExistence({
    provisioning: host.provisioning,
    projectId: STAGING_PROJECT_ID,
    objectId,
    fieldIds: templateFieldIds(template),
  })
  assert.equal(verdict.fieldExistenceMode, 'db', 'CONTROL: the probe judged in db mode')
  return missingLogicalFields(template, verdict.resolved)
}

// ── R1 ────────────────────────────────────────────────────────────────────────────────────────

async function r1MissingLineColumnsAreRepairedAdditivelyAndValuesFree() {
  const harness = mount()
  harness.host.remove(LINE_OBJECT_ID, MISSING_LINE_FIVE)
  const probeMissing = await probeMissingSet(harness.host, LINE_OBJECT_ID)
  assert.deepEqual(probeMissing, [...MISSING_LINE_FIVE], 'CONTROL: the #5721 probe sees exactly the five')
  // Forget the probe's own reads so the counts below are the ROUTE's.
  harness.host.calls.resolveExistingObjectFieldIds.length = 0

  const res = await repair(harness.routes, { body: { objectIds: [LINE_OBJECT_ID] } })
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(res.body.ok, true)
  const data = res.body.data
  assert.equal(data.ready, true)
  assert.equal(data.tables.length, 1, 'R1: only the requested table')
  const table = data.tables[0]
  assert.equal(table.objectId, LINE_OBJECT_ID)
  assert.equal(table.mode, 'mvp_repaired')
  assert.equal(table.repaired, true)
  assert.equal(table.addedFieldCount, 5)
  assert.deepEqual(table.addedFieldIds, [...MISSING_LINE_FIVE], 'R1: the response names WHICH logical fields were added')
  assert.equal(table.fieldExistenceMode, 'db')
  assert.equal(table.schemaCompleteAfter, true)
  assert.equal(data.evidence.action, 'stock_preparation_mvp_repair')
  assert.equal(data.evidence.repairedTableCount, 1)
  assert.deepEqual(data.evidence.tables[0].addedFieldIds, [...MISSING_LINE_FIVE])
  assertValuesFree(res.body, 'R1 response')

  // The host received EXACTLY the probe's missing set, once, under the staging project.
  const writes = harness.host.calls.ensureMissingObjectFields
  assert.equal(writes.length, 1, 'R1: exactly one additive call')
  assert.equal(writes[0].projectId, STAGING_PROJECT_ID)
  assert.equal(writes[0].objectId, LINE_OBJECT_ID)
  assert.deepEqual(writes[0].fields.map((field) => field.id), probeMissing, 'R1: submitted fields === the #5721 probe`s missingFields (same 口径)')
  assert.equal(harness.host.calls.runObjectFieldsRepairTransaction, 1, 'R1: ONE host transaction')
  assert.equal(harness.host.calls.resolveFieldIds.length, 0, 'R1: repair never uses the compute-only derivation')
  assertNoStructureMutationNoRowWrite(harness, 'R1')
  // The log line is counts only.
  const logged = harness.logLines.filter(([, message]) => String(message).includes('MVP repair completed'))
  assert.equal(logged.length, 1, 'R1: one values-free completion line')
  assertValuesFree(logged[0][2], 'R1 log detail')
  assert.deepEqual(logged[0][2], { tableCount: 1, repairedTableCount: 1, addedFieldCount: 5 })
  return harness
}

// ── R2 ────────────────────────────────────────────────────────────────────────────────────────

async function r2NothingMissingIsTwoHundredWithZeroWrites() {
  const harness = mount()
  const res = await repair(harness.routes, { body: {} })
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(res.body.data.tables.length, ALL_MVP_OBJECT_IDS.length, 'R2: all 9 MVP tables when objectIds is omitted')
  for (const table of res.body.data.tables) {
    assert.equal(table.mode, 'mvp_already_ready', `${table.objectId}`)
    assert.equal(table.addedFieldCount, 0)
    assert.deepEqual(table.addedFieldIds, [])
  }
  assert.equal(res.body.data.evidence.repairedTableCount, 0)
  assert.deepEqual(harness.host.calls.ensureMissingObjectFields, [], 'R2: ZERO additive calls — not an empty-list call')
  assertNoStructureMutationNoRowWrite(harness, 'R2')
  assertValuesFree(res.body, 'R2 response')
}

// ── R3 ────────────────────────────────────────────────────────────────────────────────────────

async function r3SecondCallRepairsNothing(harness) {
  const res = await repair(harness.routes, { body: { objectIds: [LINE_OBJECT_ID] } })
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(res.body.data.tables[0].mode, 'mvp_already_ready')
  assert.equal(res.body.data.tables[0].addedFieldCount, 0)
  assert.deepEqual(res.body.data.tables[0].addedFieldIds, [])
  assert.equal(harness.host.calls.ensureMissingObjectFields.length, 1, 'R3: the second call added no host write')
  assertNoStructureMutationNoRowWrite(harness, 'R3')
}

// ── R4 ────────────────────────────────────────────────────────────────────────────────────────

async function r4NonAdminIsRefusedBeforeAnyHostCall() {
  {
    const harness = mount()
    harness.host.remove(LINE_OBJECT_ID, MISSING_LINE_FIVE)
    const res = await repair(harness.routes, { user: WRITER_USER, body: { objectIds: [LINE_OBJECT_ID] } })
    assert.equal(res.statusCode, 403, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'FORBIDDEN')
    assertZeroHostCalls(harness, 'R4 writer')
  }
  {
    const harness = mount()
    const res = await repair(harness.routes, { user: null, body: {} })
    assert.equal(res.statusCode, 401, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'UNAUTHENTICATED')
    assertZeroHostCalls(harness, 'R4 anonymous')
  }
}

// ── R5 ────────────────────────────────────────────────────────────────────────────────────────

async function r5TheRequestCannotSteerTheRepair() {
  const arms = [
    ['body tenantId', { body: { tenantId: 'tenant_evil' } }, 'STOCK_PREPARATION_MVP_REPAIR_STEERING_NOT_ALLOWED'],
    ['body projectId', { body: { projectId: 'tenant_evil:integration-core' } }, 'STOCK_PREPARATION_MVP_REPAIR_STEERING_NOT_ALLOWED'],
    ['query tenantId', { query: { tenantId: 'tenant_evil' } }, 'STOCK_PREPARATION_MVP_REPAIR_STEERING_NOT_ALLOWED'],
    ['query projectId', { query: { projectId: 'tenant_evil:integration-core' } }, 'STOCK_PREPARATION_MVP_REPAIR_STEERING_NOT_ALLOWED'],
    ['params projectId', { params: { projectId: 'tenant_evil:integration-core' } }, 'STOCK_PREPARATION_MVP_REPAIR_STEERING_NOT_ALLOWED'],
    ['query baseId', { query: { baseId: 'base_of_tenant_evil' } }, 'STOCK_PREPARATION_MVP_REPAIR_STEERING_NOT_ALLOWED'],
    ['body baseId', { body: { baseId: 'base_of_tenant_evil' } }, 'STOCK_PREPARATION_BASE_ID_NOT_ALLOWED'],
    ['caller-supplied field list', { body: { objectIds: [LINE_OBJECT_ID], fields: [{ id: 'ext_backdoor', type: 'text' }] } }, 'STOCK_PREPARATION_MVP_REPAIR_REQUEST_INVALID'],
    ['unknown key', { body: { sheetId: 'sheet_x' } }, 'STOCK_PREPARATION_MVP_REPAIR_REQUEST_INVALID'],
    // 反驳 r1: workspaceId was accepted-and-ignored; now it is simply not a key of this route.
    ['accepted-and-ignored key workspaceId', { body: { objectIds: [LINE_OBJECT_ID], workspaceId: 'ws_1' } }, 'STOCK_PREPARATION_MVP_REPAIR_REQUEST_INVALID'],
    // 反驳 r1: an objectIds key that names nothing must not widen into "all 9 tables".
    ['empty objectIds []', { body: { objectIds: [] } }, 'STOCK_PREPARATION_MVP_REPAIR_REQUEST_INVALID'],
    ['objectIds with no usable entry [123, null]', { body: { objectIds: [123, null] } }, 'STOCK_PREPARATION_MVP_REPAIR_REQUEST_INVALID'],
    ['objectIds empty string', { body: { objectIds: '' } }, 'STOCK_PREPARATION_MVP_REPAIR_REQUEST_INVALID'],
  ]
  for (const [label, req, code] of arms) {
    const harness = mount()
    harness.host.remove(LINE_OBJECT_ID, MISSING_LINE_FIVE)
    const res = await repair(harness.routes, { body: { objectIds: [LINE_OBJECT_ID] }, ...req })
    assert.equal(res.statusCode, 400, `R5 [${label}]: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.error.code, code, `R5 [${label}]`)
    assertZeroHostCalls(harness, `R5 [${label}]`)
    assert.equal(JSON.stringify(res.body).includes('tenant_evil'), false, `R5 [${label}]: the steering value is not echoed`)
  }
  // Control: without a steering / unknown key the same request is NOT refused on that ground.
  const harness = mount()
  const ok = await repair(harness.routes, { body: { objectIds: [LINE_OBJECT_ID] } })
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
  // Control: an OMITTED objectIds key still means every MVP table (R2 proves the count).
  const omitted = await repair(mount().routes, { body: {} })
  assert.equal(omitted.statusCode, 200, JSON.stringify(omitted.body))
  assert.equal(omitted.body.data.tables.length, ALL_MVP_OBJECT_IDS.length)
}

// ── R6 ────────────────────────────────────────────────────────────────────────────────────────

async function r6AnOldHostIsRefusedNotImplemented() {
  const harness = mount({ withRepairRunner: false })
  harness.host.remove(LINE_OBJECT_ID, MISSING_LINE_FIVE)
  const res = await repair(harness.routes, { body: { objectIds: [LINE_OBJECT_ID] } })
  assert.equal(res.statusCode, 501, JSON.stringify(res.body))
  assert.equal(res.body.error.code, 'MVP_REPAIR_API_UNAVAILABLE')
  assert.deepEqual(clone(res.body.error.details), { requiredMethods: ['runObjectFieldsRepairTransaction'] })
  assertValuesFree(res.body, 'R6 response')
  assertZeroHostCalls(harness, 'R6')
}

// ── R7 ────────────────────────────────────────────────────────────────────────────────────────

async function r7TheRepairedProjectIsTheAuthenticatedTenantsStagingProject() {
  for (const [tenantId, user] of [[TENANT_ID, ADMIN_USER], ['tenant_2', { ...ADMIN_USER, id: 'user_admin_2', tenantId: 'tenant_2' }]]) {
    const harness = mount()
    harness.host.remove(LINE_OBJECT_ID, MISSING_LINE_FIVE)
    const res = await repair(harness.routes, { user, body: { objectIds: [LINE_OBJECT_ID] } })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const touched = harness.host.projectIdsTouched()
    assert.ok(touched.length >= 5, 'R7: the host was asked (find/resolve/read/write/resolve)')
    for (const projectId of touched) {
      assert.equal(projectId, `${tenantId}:integration-core`, 'R7: every host call is under the AUTHENTICATED tenant`s staging project')
    }
    assert.equal(JSON.stringify(res.body).includes(':integration-core'), false, 'R7: the project id is not echoed')
  }
}

// ── R8 ────────────────────────────────────────────────────────────────────────────────────────

async function r8TheVerbsOwnRefusalsPassThroughWithZeroWrites() {
  {
    const harness = mount()
    const res = await repair(harness.routes, { body: { objectIds: ['plm_stock_preparation_main'] } })
    assert.equal(res.statusCode, 422, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'MVP_TARGET_OBJECT_ID_INVALID')
    assert.equal(harness.host.calls.runObjectFieldsRepairTransaction, 0, 'R8: no transaction for a non-MVP objectId')
    assertZeroHostCalls(harness, 'R8 canonical objectId')
  }
  {
    const harness = mount({ absentObjectIds: [LINE_OBJECT_ID] })
    const res = await repair(harness.routes, { body: { objectIds: [LINE_OBJECT_ID] } })
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'MVP_REPAIR_TARGET_ABSENT')
    assert.deepEqual(harness.host.calls.ensureMissingObjectFields, [], 'R8: an absent table is never created or written')
    assertNoStructureMutationNoRowWrite(harness, 'R8 absent table')
    assertValuesFree(res.body, 'R8 absent response')
  }
}

// ── R10 ───────────────────────────────────────────────────────────────────────────────────────

async function r10AnUnregisteredObjectIdIsRefusedValuesFreeWithZeroWrites() {
  {
    const harness = mount({ unregisteredObjectIds: [LINE_OBJECT_ID] })
    harness.host.remove(LINE_OBJECT_ID, MISSING_LINE_FIVE)
    const res = await repair(harness.routes, { body: { objectIds: [LINE_OBJECT_ID] } })
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'MVP_REPAIR_SCOPE_UNAVAILABLE')
    assert.deepEqual(clone(res.body.error.details), { objectId: LINE_OBJECT_ID, hostMethod: 'resolveExistingObjectFieldIds' })
    assertValuesFree(res.body, 'R10 response')
    assert.equal(String(res.body.error.message).includes('cannot claim'), false, 'R10: the host message is not forwarded')
    // Every log line: the plugin-name prefix `[plugin-integration-core]` is not a value, the project id
    // `${tenant}:integration-core`, the tenant id and the host's message text are.
    for (const line of harness.logLines) {
      const text = JSON.stringify(line)
      for (const token of [TENANT_ID, ':integration-core', 'cannot claim', 'sheet_', 'fld_']) {
        assert.equal(text.includes(token), false, `R10 log line must not leak "${token}"`)
      }
    }
    assert.deepEqual(harness.host.calls.ensureMissingObjectFields, [], 'R10: zero additive writes')
    assert.equal(harness.host.calls.runObjectFieldsRepairTransaction, 1, 'R10: the one transaction was opened')
    assert.equal(harness.host.calls.rolledBackTransactions, 1, 'R10: and rolled back by the typed throw')
    assertNoStructureMutationNoRowWrite(harness, 'R10')
  }
  {
    // Atomic: the FIRST table's additive write is already submitted inside the tx when the second
    // (unregistered) table refuses — the whole sweep rolls back and the response is the same 409.
    const [batchObjectId] = ALL_MVP_OBJECT_IDS.filter((objectId) => objectId !== LINE_OBJECT_ID && objectId.endsWith('_bom_snapshot_batch'))
    assert.ok(batchObjectId, 'CONTROL: the batch table is an MVP table')
    const harness = mount({ unregisteredObjectIds: [LINE_OBJECT_ID] })
    harness.host.remove(batchObjectId, ['snapshotVersion'])
    harness.host.remove(LINE_OBJECT_ID, MISSING_LINE_FIVE)
    const res = await repair(harness.routes, { body: { objectIds: [batchObjectId, LINE_OBJECT_ID] } })
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'MVP_REPAIR_SCOPE_UNAVAILABLE')
    assert.equal(res.body.error.details.objectId, LINE_OBJECT_ID)
    assertValuesFree(res.body, 'R10 two-table response')
    assert.equal(harness.host.calls.ensureMissingObjectFields.length, 1, 'CONTROL: the registered table`s write was submitted inside the tx')
    assert.equal(harness.host.calls.ensureMissingObjectFields[0].objectId, batchObjectId)
    assert.equal(harness.host.calls.rolledBackTransactions, 1, 'R10: the whole sweep rolled back')
    assertNoStructureMutationNoRowWrite(harness, 'R10 two-table')
  }
}

// ── R9 ────────────────────────────────────────────────────────────────────────────────────────

function r9TheRouteTableNamesTheRouteOnce() {
  const entries = httpRoutes.ROUTES.filter(([, routePath]) => routePath === REPAIR_ROUTE)
  assert.equal(entries.length, 1, 'R9: exactly one route-table entry')
  assert.deepEqual(entries[0], ['POST', REPAIR_ROUTE, 'stockPreparationMvpRepair'])
}

async function main() {
  const r1 = await r1MissingLineColumnsAreRepairedAdditivelyAndValuesFree()
  await r2NothingMissingIsTwoHundredWithZeroWrites()
  await r3SecondCallRepairsNothing(r1)
  await r4NonAdminIsRefusedBeforeAnyHostCall()
  await r5TheRequestCannotSteerTheRepair()
  await r6AnOldHostIsRefusedNotImplemented()
  await r7TheRepairedProjectIsTheAuthenticatedTenantsStagingProject()
  await r8TheVerbsOwnRefusalsPassThroughWithZeroWrites()
  r9TheRouteTableNamesTheRouteOnce()
  await r10AnUnregisteredObjectIdIsRefusedValuesFreeWithZeroWrites()
  console.log('stock-preparation-mvp-repair-routes tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
