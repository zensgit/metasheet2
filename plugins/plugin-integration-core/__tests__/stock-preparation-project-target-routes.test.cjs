'use strict'

// 一个项目一张备料表 — THE THREE S1 ROUTES and the overlay as the existing routes see it (S1 of ADR
// adr-stock-prep-project-sheets-20261008 §2 / §4 / §3). The real route stack is mounted; the
// registry store is the REAL one over an in-memory db; the host provisioning, records, audit gate
// and tenant directory are fakes in the shape of the handoff suite's.
//
//   R-01 SWITCH OFF: all three routes answer 404 STOCK_PREPARATION_PROJECT_SHEETS_DISABLED with ZERO
//        host calls, zero store calls and zero audit rows — for every tier, puller included — and
//        the conflict-policies list without a project number still answers as it always did.
//   R-02 CREATE: the floor (read+operate) is refused 403 before any IO; a PULLER gets 201 with a
//        sheet provisioned through the one create path, a registry row, an audit row
//        `project_target_create`, and the G1 grant called with EXACTLY the configured roles and
//        audited `project_target_grant`; the SAME call again is 200 created:false, no new row, no
//        second sheet, the grant re-run (idempotent) and audited `already_granted`.
//   R-03 THE CAP: at 200 registered rows (archived included) the create is 409 LIMIT, nothing
//        provisioned.
//   R-04 ARCHIVED: create is 409 ARCHIVED; GET reports status archived with may.restore by tier.
//   R-05 GET absent: status absent, may.create true for the puller and false for the floor.
//   R-06 GET active: sheet / view / to-fill handles and the row counts from the records read.
//   R-07 LIST: the tenant's rows, handles and enums only, never another tenant's.
//   R-08 CONFLICT-POLICIES, switch on: without ?projectNo= → 400 PROJECT_NO_REQUIRED; with an
//        unregistered number → 409 ABSENT; a registered one resolves the project sheet (the policy
//        key) and runs the wall.
//   R-09 DRY-RUN, switch on: an unregistered project is 409 ABSENT and an archived one 409
//        ARCHIVED — before any source read, any B2a claim, any records IO.
//   R-10 THE WALL: a registered sheet the registry does NOT attribute to the caller's project (and
//        whose id is not the derived one) refuses the dry-run 409 TABLE_ACTION_TARGET_TENANT_MISMATCH.
//   R-11 G1 REFUSAL: a port refusal after the row is registered surfaces with its status; the
//        replay returns 200 and re-attempts the grant.
//   R-12 SHAPE: a non-empty create body is 400; a malformed project number is 400.
//   R-13 BOARD: with the switch on an unregistered project renders as "no bound target" (200),
//        never a 409 — the ABSENT refusal is caught like TABLE_ACTION_NOT_CONFIGURED.
//   R-14 (R1) A LARGE-BOM JOB PLANNED BEFORE THE FLIP: its snapshot names the env sheet; once the
//        switch is on and the project has its registered sheet, plan / apply-start / apply-run all
//        refuse 409 STOCK_PREPARATION_JOB_TARGET_STALE before any records IO, and the already
//        approved apply job is left untouched.
//   R-15 (R1 / E2c) A JOB WHOSE SNAPSHOT IS THE REGISTERED SHEET proceeds through plan, apply-start
//        and apply-run — the write gate admits the project sheet through its project branch (the env
//        allowlist never names it), so sourcing the gate's registry objectId from the deployment
//        objectId would refuse here.
//   R-16 (R1) SWITCH OFF: the same env-sheet job answers byte-identically (timestamps and the minted
//        apply job id canonicalized) with the registry wired and without it, and the registry is
//        never consulted.
//   R-17 (E2a) THE SWITCH IS READ PER REQUEST: one mount, the env flipped between calls, the three
//        routes follow the flip (and only the exact literal counts).
//   R-18 (E2d) ARCHIVED, switch on: the small apply, conflict-policies save / delete and the handoff
//        advance each refuse 409 ARCHIVED — each is a WRITE-purpose lookup, so a purpose downgraded
//        to 'read' on any of them resolves the archived sheet instead and reds here.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { STOCK_PREP_AUDIT_ACTIONS, __internals: auditInternals } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const { createStockPreparationProjectTargetStore } = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
const {
  PROJECT_SHEETS_ENABLED_ENV,
  PROJECT_SHEET_GRANT_ROLE_IDS_ENV,
  MAX_PROJECT_TARGETS_PER_TENANT,
  deriveProjectSheetObjectId,
} = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE, STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID } = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))
const largeBomJobs = require(path.join(LIB, 'stock-preparation-large-bom-jobs.cjs'))

const TENANT = 'tenant-s1-routes'
const OTHER_TENANT = 'tenant-s1-foreign'
const PROJECT = 'PRJ-S1-R1'
const PROJECT_ID = `${TENANT}:integration-core`
const ENV_SHEET = 'sheet_env_mixed'
const ENV_OBJECT = 'plm_stock_preparation_sandbox_env_twin'
const ROLE_A = 'stock-prep_frontline'
const ROLE_B = 'stock-prep_puller'

const GET_PATH = '/api/integration/stock-preparation/projects/:projectNo/target'
const CREATE_PATH = '/api/integration/stock-preparation/projects/:projectNo/target'
const LIST_PATH = '/api/integration/stock-preparation/project-targets'
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const POLICIES_PATH = '/api/integration/table-actions/:actionId/conflict-policies'
const BOARD_PATH = '/api/integration/stock-preparation/projects/:projectNo/board'
const APPLY_PATH = '/api/integration/table-actions/:actionId/apply'
const HANDOFF_ADVANCE_PATH = '/api/integration/stock-preparation/handoff/advance'
const JOBS_PATH = '/api/integration/table-actions/:actionId/large-bom/expansion-jobs'
const PLAN_PATH = `${JOBS_PATH}/:jobId/plan`
const APPLY_START_PATH = `${JOBS_PATH}/:jobId/apply-jobs`
const APPLY_RUN_PATH = `${JOBS_PATH}/:jobId/apply-jobs/:applyJobId/run`
// What `largeBomJobScope` derives for a request that names only the tenant.
const JOB_SCOPE = Object.freeze({ tenantId: TENANT, workspaceId: 'workspace-default' })

const FLOOR = Object.freeze({ id: 'u_floor', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const PULLER = Object.freeze({ id: 'u_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const READ_ONLY = Object.freeze({ id: 'u_read', tenantId: TENANT, permissions: [STOCK_PREP_READ] })
const PLATFORM_ADMIN = Object.freeze({ id: 'u_admin', tenantId: TENANT, permissions: ['role:admin', 'integration:admin'] })

// ── substrate ────────────────────────────────────────────────────────────────────────────────────

function makeMemoryDb() {
  const rows = []
  const calls = []
  const matches = (row, where) => Object.entries(where).every(([c, v]) => (row[c] === undefined ? null : row[c]) === (v === undefined ? null : v))
  const api = {
    rows,
    calls,
    // E1: the store's create runs lock → count → insert on a transaction handle; this fake runs the
    // callback inline (no isolation) and records the lock so a suite can see it was taken.
    async transaction(fn) { calls.push('transaction'); return fn({ ...api, async advisoryXactLock(key) { calls.push(`advisoryXactLock:${key}`) } }) },
    async selectOne(_t, where) { calls.push('selectOne'); return rows.find((r) => matches(r, where)) || null },
    async select(_t, { where } = {}) { calls.push('select'); return rows.filter((r) => matches(r, where || {})) },
    async insertOne(_t, row) {
      calls.push('insertOne')
      if (rows.some((r) => r.tenant_id === row.tenant_id && r.project_no === row.project_no)) {
        throw Object.assign(new Error('dup'), { code: '23505', constraint: 'uniq_integration_stock_prep_project_target_scope' })
      }
      const s = { archived_at: null, created_at: new Date('2026-10-09T00:00:00Z'), ...row }
      rows.push(s)
      return [s]
    },
    async countRows(_t, where) { calls.push('countRows'); return rows.filter((r) => matches(r, where || {})).length },
    // S4 fix round 1: the create REPLAY re-reads its row FOR UPDATE under the tenant lock.
    async selectOneForUpdate(_t, where) { calls.push('selectOneForUpdate'); return rows.find((r) => matches(r, where)) || null },
  }
  return api
}

/**
 * The host provisioning fake. `ownedByProject(sheetId, projectId)` decides the registry answer the
 * tenant wall asks; by default a sheet this fake provisioned under a project is that project's.
 */
function makeProvisioning({ grant = async () => ({ granted: [], alreadyGranted: [] }), owned } = {}) {
  const calls = []
  const objects = new Map()
  const sheetIdOf = (projectId, objectId) => `sheet_${projectId}_${objectId}`.replace(/[^A-Za-z0-9_]/g, '_')
  const api = {
    calls,
    objects,
    getObjectSheetId: (projectId, objectId) => sheetIdOf(projectId, objectId),
    getFieldId: (_p, objectId, fieldId) => `fld_${objectId.slice(-6)}_${fieldId}`,
    getObjectViewId: (_p, objectId, viewId) => `view_${objectId.slice(-6)}_${viewId}`,
    async findObjectSheet({ projectId, objectId }) {
      calls.push(['findObjectSheet', objectId])
      const key = `${projectId}/${objectId}`
      return objects.has(key) ? { id: sheetIdOf(projectId, objectId), baseId: objects.get(key).baseId, name: objects.get(key).name, description: null } : null
    },
    async resolveFieldIds({ projectId, objectId, fieldIds }) {
      calls.push(['resolveFieldIds', objectId])
      const map = {}
      for (const fieldId of fieldIds) map[fieldId] = api.getFieldId(projectId, objectId, fieldId)
      return map
    },
    async ensureObject({ projectId, baseId, descriptor }) {
      calls.push(['ensureObject', descriptor.id])
      objects.set(`${projectId}/${descriptor.id}`, { baseId: baseId ?? null, name: descriptor.name })
      return {
        baseId: baseId ?? null,
        sheet: { id: sheetIdOf(projectId, descriptor.id), baseId: baseId ?? null, name: descriptor.name, description: null },
        fields: descriptor.fields.map((f, i) => ({ id: api.getFieldId(projectId, descriptor.id, f.id), sheetId: sheetIdOf(projectId, descriptor.id), name: f.name, type: f.type, property: {}, order: i })),
      }
    },
    async ensureObjectDefaultView({ objectId }) { calls.push(['ensureObjectDefaultView', objectId]); return { created: true, existingViewCount: 0 } },
    async ensureView({ projectId, sheetId, descriptor }) { calls.push(['ensureView', descriptor.id]); return { id: api.getObjectViewId(projectId, descriptor.objectId, descriptor.id), sheetId, name: descriptor.name, type: 'grid', filterInfo: {}, sortInfo: {}, groupInfo: {}, hiddenFieldIds: [], config: {} } },
    async ensureSystemBase({ baseId }) { calls.push(['ensureSystemBase', baseId]); return { baseId, created: true } },
    async isSheetOwnedByProject(sheetId, projectId) {
      calls.push(['isSheetOwnedByProject', sheetId, projectId])
      if (owned) return owned(sheetId, projectId)
      return [...objects.keys()].some((key) => key.startsWith(`${projectId}/`) && sheetIdOf(projectId, key.split('/')[1]) === sheetId)
    },
    async findObjectView() { calls.push(['findObjectView']); return null },
    async grantSheetRoleWrite(input) { calls.push(['grantSheetRoleWrite', input]); return grant(input) },
  }
  return api
}

function makeRecordsApi(rowsBySheet = {}) {
  const queries = []
  const writes = []
  return {
    queries,
    writes,
    async queryRecords(input) {
      queries.push(input)
      const rows = rowsBySheet[input.sheetId] || []
      return rows.slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
    },
    // The apply chunk (R-15 / R-16) requires the write pair to exist; nothing in this suite writes a
    // row (every seeded plan is empty), and `writes` proves it.
    async createRecord(input) { writes.push(['createRecord', input]); return { id: `rec_${writes.length}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } } },
    async patchRecord(input) { writes.push(['patchRecord', input]); return { id: input.recordId, sheetId: input.sheetId, version: 2, data: { ...(input.changes || {}) } } },
  }
}

function inertService(methods) {
  const service = {}
  for (const method of methods) service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
  return service
}

function baseServices() {
  return {
    externalSystemRegistry: inertService(['upsertExternalSystem', 'getExternalSystem', 'getExternalSystemForAdapter', 'deleteExternalSystem', 'listExternalSystems']),
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

function mount({ env = {}, provisioning = makeProvisioning(), records = makeRecordsApi(), db = makeMemoryDb(), withStore = true, configExtras = {}, serviceExtras = {} } = {}) {
  const routes = new Map()
  const auditAppends = []
  const context = {
    api: {
      http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } },
      multitable: { provisioning, records },
    },
    // `durable: true` is what the large-BOM job store demands before it accepts a job (R-14..R-16).
    storage: Object.assign(new Map(), { durable: true }),
    config: {
      stockPreparationTableActions: [{
        actionId: PLM_STOCK_PREPARATION_ACTION_ID,
        source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' },
        target: { sheetId: ENV_SHEET, objectId: ENV_OBJECT, fieldIdMap: {} },
      }],
      stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [ENV_OBJECT] },
      ...configExtras,
    },
  }
  const services = Object.assign(baseServices(), serviceExtras)
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
  const store = withStore ? createStockPreparationProjectTargetStore({ db, idGenerator: () => `pt-${(n += 1)}` }) : null
  services.stockPreparationProjectTargetStore = store
  services.tenantPrincipalDirectory = { async verifyTenantMembership() { return { member: true } } }
  const previousEnv = {}
  for (const key of [PROJECT_SHEETS_ENABLED_ENV, PROJECT_SHEET_GRANT_ROLE_IDS_ENV, 'MULTITABLE_STOCK_PREP_OWN_BASE']) {
    previousEnv[key] = process.env[key]
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
  return {
    routes, auditAppends, provisioning, records, db, store, context,
    restore() { for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } },
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
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {}, authenticatedTenantId: req.authenticatedTenantId }, res)
  return res
}

const getTarget = (routes, user, projectNo = PROJECT) => call(routes, 'GET', GET_PATH, { user, params: { projectNo }, query: { tenantId: TENANT } })
const createTarget = (routes, user, projectNo = PROJECT, body = {}) => call(routes, 'POST', CREATE_PATH, { user, params: { projectNo }, body })
const listTargets = (routes, user) => call(routes, 'GET', LIST_PATH, { user, query: { tenantId: TENANT } })
const dryRun = (routes, user, projectNo = PROJECT) => call(routes, 'POST', DRY_RUN_PATH, { user, params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, body: { parameters: { projectNo } }, query: { tenantId: TENANT } })
const policies = (routes, user, query = {}) => call(routes, 'GET', POLICIES_PATH, { user, params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, query: { tenantId: TENANT, ...query } })

function registerActive(harness, projectNo = PROJECT, { archived = false, tenantId = TENANT } = {}) {
  const projectId = `${tenantId}:integration-core`
  const objectId = deriveProjectSheetObjectId(tenantId, projectNo)
  harness.provisioning.objects.set(`${projectId}/${objectId}`, { baseId: null, name: `备料-${projectNo}` })
  const sheetId = harness.provisioning.getObjectSheetId(projectId, objectId)
  harness.db.rows.push({ id: `seed-${projectNo}`, tenant_id: tenantId, project_no: projectNo, sheet_id: sheetId, object_id: objectId, status: archived ? 'archived' : 'active', created_by: 'seed', created_at: new Date('2026-10-08T00:00:00Z'), archived_at: archived ? new Date('2026-10-09T00:00:00Z') : null })
  return { sheetId, objectId }
}

/**
 * A completed, authoritative, already-planned large-BOM expansion job written straight into the
 * route's own durable storage — the state a job is in once a puller has expanded and planned it —
 * with its snapshot bound to `target`. Rows and decisions are empty: these cases are about WHICH
 * sheet the job addresses, not what it writes.
 */
async function seedPlannedExpansionJob(h, { jobId, target, projectNo = PROJECT }) {
  const actionId = PLM_STOCK_PREPARATION_ACTION_ID
  const at = '2026-10-09T00:00:00.000Z'
  const job = {
    jobId, ...JOB_SCOPE, actionId,
    status: 'completed', authoritative: true, projectNoPresent: true,
    parameters: { projectNo },
    principal: 'u_pull',
    actionSnapshot: {
      actionId,
      source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' },
      target,
    },
    sourceKind: 'data-source:sql-readonly',
    artifactRevision: 'artifact-1',
    artifact: { revision: 'artifact-1', status: 'expanded', rows: [], summary: {}, sealedAt: at },
    planRevision: 'plan-1',
    planArtifact: { revision: 'plan-1', artifactRevision: 'artifact-1', plan: { revision: 'plan-1', decisions: [], plannedAt: at }, existingRowCount: 0, plannedAt: at },
    progress: { rowsExpanded: 0, readCount: 0, frontierRemaining: 0, completedChunks: 1 },
    budgets: {},
    evidence: { sourceKind: 'data-source:sql-readonly', readObjects: [], errorTypes: [], readDiagnosticShapePresent: false },
    createdAt: at, updatedAt: at,
  }
  await h.context.storage.set(largeBomJobs.__internals.backgroundJobKey({ ...JOB_SCOPE, actionId, jobId }), job)
  return job
}

const jobParams = (jobId, applyJobId) => ({ actionId: PLM_STOCK_PREPARATION_ACTION_ID, jobId, ...(applyJobId ? { applyJobId } : {}) })
const plan = (routes, jobId) => call(routes, 'POST', PLAN_PATH, { user: PLATFORM_ADMIN, params: jobParams(jobId), body: {}, query: { tenantId: TENANT } })
const applyStart = (routes, jobId) => call(routes, 'POST', APPLY_START_PATH, { user: PLATFORM_ADMIN, params: jobParams(jobId), body: { confirm: { acceptManualConfirmHold: true } }, query: { tenantId: TENANT } })
const applyRun = (routes, jobId, applyJobId) => call(routes, 'POST', APPLY_RUN_PATH, { user: PLATFORM_ADMIN, params: jobParams(jobId, applyJobId), body: {}, query: { tenantId: TENANT } })
const ENV_TARGET = Object.freeze({ sheetId: ENV_SHEET, objectId: ENV_OBJECT, fieldIdMap: {} })

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('R-14 (R1) a large-BOM job planned against the env sheet BEFORE the flip is refused 409 JOB_TARGET_STALE by plan, apply-start and apply-run once the switch is on', async () => {
  const h = mount({ env: {} })
  try {
    const jobId = 'job-pre-flip'
    await seedPlannedExpansionJob(h, { jobId, target: ENV_TARGET })
    // Before the flip: planned and approved exactly as today (switch off → no overlay, no registry).
    const planned = await plan(h.routes, jobId)
    assert.equal(planned.statusCode, 200, JSON.stringify(planned.body))
    const approved = await applyStart(h.routes, jobId)
    assert.equal(approved.statusCode, 202, JSON.stringify(approved.body))
    const applyJobId = approved.body.data.jobId
    assert.deepEqual(h.db.calls, [], 'the registry was never consulted before the flip')
    // THE FLIP: the switch goes on and the project gets its own registered sheet.
    process.env[PROJECT_SHEETS_ENABLED_ENV] = 'true'
    registerActive(h)
    const queriesBefore = h.records.queries.length
    // (The registry's own binding build resolves the PROJECT sheet's field ids; what must not happen
    // is a probe of the stale ENV sheet.)
    const envProbes = () => h.provisioning.calls.filter((c) => c[0] === 'resolveFieldIds' && c[1] === ENV_OBJECT).length
    const fieldProbesBefore = envProbes()
    for (const [label, run] of [
      ['plan', () => plan(h.routes, jobId)],
      ['apply-start', () => applyStart(h.routes, jobId)],
      ['apply-run', () => applyRun(h.routes, jobId, applyJobId)],
    ]) {
      const res = await run()
      assert.equal(res.statusCode, 409, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_JOB_TARGET_STALE', label)
      assert.deepEqual({ ...res.body.error.details }, { field: 'jobId', snapshot: 'expansion', objectIdMatches: false, sheetIdMatches: false }, `${label}: values-free details`)
    }
    assert.equal(h.records.queries.length, queriesBefore, 'no records IO on the stale sheet after the flip')
    assert.equal(envProbes(), fieldProbesBefore, 'no field probe on the stale sheet after the flip')
    assert.deepEqual(h.records.writes, [], 'no write')
    const stored = await h.context.storage.get(largeBomJobs.__internals.checkpointApplyJobKey({ ...JOB_SCOPE, actionId: PLM_STOCK_PREPARATION_ACTION_ID, applyJobId }))
    assert.equal(stored.status, 'queued', 'the approved apply job is left exactly as it was')
    assert.equal(stored.checkpoint.nextDecisionIndex, 0)
    assert.equal(stored.target.sheetId, ENV_SHEET, 'the stored target is not rewritten either')
  } finally { h.restore() }
})

test('R-15 (R1 / E2c) a job whose snapshot IS the registered sheet proceeds through plan, apply-start and apply-run — the gate admits the project sheet', async () => {
  const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' } })
  try {
    const { sheetId, objectId } = registerActive(h)
    assert.ok(!h.context.config.stockPrepApplySandbox.allowedTargetObjectIds.includes(objectId), 'the env allowlist never names the project sheet')
    const jobId = 'job-post-flip'
    await seedPlannedExpansionJob(h, { jobId, target: { sheetId, objectId, fieldIdMap: {} } })
    const planned = await plan(h.routes, jobId)
    assert.equal(planned.statusCode, 200, JSON.stringify(planned.body))
    const approved = await applyStart(h.routes, jobId)
    assert.equal(approved.statusCode, 202, JSON.stringify(approved.body))
    const applyJobId = approved.body.data.jobId
    const ran = await applyRun(h.routes, jobId, applyJobId)
    assert.equal(ran.statusCode, 200, JSON.stringify(ran.body))
    const stored = await h.context.storage.get(largeBomJobs.__internals.checkpointApplyJobKey({ ...JOB_SCOPE, actionId: PLM_STOCK_PREPARATION_ACTION_ID, applyJobId }))
    assert.notEqual(stored.status, 'queued', 'the chunk ran (the write path was reached)')
    assert.equal(stored.target.sheetId, sheetId, 'on the project sheet')
    assert.deepEqual(h.records.writes, [], 'an empty plan writes no row')
  } finally { h.restore() }
})

test('R-16 (R1) switch OFF: the three routes answer byte-identically for the same env-sheet job with and without the registry wired', async () => {
  const run = async (withStore) => {
    const h = mount({ env: {}, withStore })
    try {
      const jobId = 'job-switch-off'
      await seedPlannedExpansionJob(h, { jobId, target: ENV_TARGET })
      const planned = await plan(h.routes, jobId)
      const approved = await applyStart(h.routes, jobId)
      const applyJobId = approved.body && approved.body.data ? approved.body.data.jobId : null
      const ran = await applyRun(h.routes, jobId, applyJobId)
      assert.deepEqual(h.db.calls, [], 'the registry is never consulted while the switch is off')
      // Clocks and the minted apply-job id are the only things that may differ between two runs.
      const canon = (res) => JSON.parse(JSON.stringify([res.statusCode, res.body])
        .split(applyJobId).join('<applyJobId>')
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<ts>'))
      return [canon(planned), canon(approved), canon(ran)]
    } finally { h.restore() }
  }
  const wired = await run(true)
  const bare = await run(false)
  assert.equal(wired[0][0], 200, JSON.stringify(wired[0][1]))
  assert.equal(wired[1][0], 202, JSON.stringify(wired[1][1]))
  assert.equal(wired[2][0], 200, JSON.stringify(wired[2][1]))
  assert.deepEqual(wired, bare)
})

test('R-17 (E2a) the switch is read PER REQUEST: one mount, the env flipped between calls, the routes follow the flip', async () => {
  const h = mount({ env: {} })
  try {
    const flip = (value) => { if (value === undefined) delete process.env[PROJECT_SHEETS_ENABLED_ENV]; else process.env[PROJECT_SHEETS_ENABLED_ENV] = value }
    assert.equal((await getTarget(h.routes, PULLER)).statusCode, 404)
    flip('true')
    const on = await getTarget(h.routes, PULLER)
    assert.equal(on.statusCode, 200, JSON.stringify(on.body))
    assert.equal(on.body.data.status, 'absent')
    assert.equal((await listTargets(h.routes, PULLER)).statusCode, 200)
    flip(undefined)
    assert.equal((await getTarget(h.routes, PULLER)).statusCode, 404)
    assert.equal((await listTargets(h.routes, PULLER)).statusCode, 404)
    assert.equal((await createTarget(h.routes, PULLER)).statusCode, 404)
    // Only the exact literal counts — per request, too.
    for (const near of ['TRUE', ' true', 'true ', '1', 'yes']) {
      flip(near)
      assert.equal((await getTarget(h.routes, PULLER)).statusCode, 404, `not the literal: ${JSON.stringify(near)}`)
    }
    flip('true')
    const created = await createTarget(h.routes, PULLER)
    assert.equal(created.statusCode, 201, JSON.stringify(created.body))
    flip(undefined)
    assert.equal((await getTarget(h.routes, PULLER)).statusCode, 404, 'off again, even with a registered row')
  } finally { h.restore() }
})

test('R-18 (E2d) archived project, switch ON: small apply, conflict-policies save / delete and handoff advance all refuse 409 ARCHIVED', async () => {
  const handoffStore = {
    async get() { return null },
    async advance() { throw new Error('unexpected handoff advance') },
    async claimNotification() { throw new Error('unexpected handoff claim') },
  }
  const h = mount({
    env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' },
    configExtras: {
      stockPreparationHandoff: {
        tenantId: TENANT,
        steps: [{ key: 'prep_entry', handlerUserIds: [PLATFORM_ADMIN.id] }],
        notify: { groupDestinationId: 'dest-prep' },
        terminal: { groupDestinationIds: ['dest-warehouse'], exportPath: '/stock-prep' },
      },
    },
    serviceExtras: { stockPreparationHandoffStore: handoffStore },
  })
  try {
    const ARCHIVED = 'PRJ-S1-ARCH'
    registerActive(h, ARCHIVED, { archived: true })
    const actionId = PLM_STOCK_PREPARATION_ACTION_ID
    const cases = [
      ['POST', APPLY_PATH, { params: { actionId }, body: { parameters: { projectNo: ARCHIVED } }, query: { tenantId: TENANT } }],
      ['PUT', POLICIES_PATH, { params: { actionId }, body: {}, query: { tenantId: TENANT, projectNo: ARCHIVED } }],
      ['DELETE', POLICIES_PATH, { params: { actionId }, body: {}, query: { tenantId: TENANT, projectNo: ARCHIVED } }],
      ['POST', HANDOFF_ADVANCE_PATH, { body: { projectNo: ARCHIVED, fromStepKey: 'prep_entry' }, query: {} }],
    ]
    for (const [method, routePath, req] of cases) {
      const res = await call(h.routes, method, routePath, { user: PLATFORM_ADMIN, ...req })
      assert.equal(res.statusCode, 409, `${method} ${routePath}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED', `${method} ${routePath}`)
    }
    assert.deepEqual(h.records.queries, [], 'no records IO')
    assert.deepEqual(h.auditAppends, [], 'no audit row')
    // Positive control for the handoff case: the same request against an ACTIVE project gets past the
    // lookup (it then fails on the existence probe against the empty sheet — a different refusal).
    registerActive(h)
    const active = await call(h.routes, 'POST', HANDOFF_ADVANCE_PATH, { user: PLATFORM_ADMIN, body: { projectNo: PROJECT, fromStepKey: 'prep_entry' }, query: {} })
    assert.notEqual(active.body.error && active.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
  } finally { h.restore() }
})

test('R-01 switch OFF: 404 DISABLED on all three routes, zero IO, for every tier; the legacy conflict-policies read is unchanged', async () => {
  const h = mount({ env: {} })
  try {
    // The permission gate precedes the switch check (the call-site guard pins the order), so only a
    // caller the gate admits sees the 404: GET / LIST for OPERATE and above, CREATE for PULL and above.
    for (const [user, paths] of [
      [FLOOR, [['GET', GET_PATH], ['GET', LIST_PATH]]],
      [PULLER, [['GET', GET_PATH], ['POST', CREATE_PATH], ['GET', LIST_PATH]]],
      [PLATFORM_ADMIN, [['GET', GET_PATH], ['POST', CREATE_PATH], ['GET', LIST_PATH]]],
    ]) {
      for (const [method, routePath] of paths) {
        const res = await call(h.routes, method, routePath, { user, params: { projectNo: PROJECT }, query: { tenantId: TENANT } })
        assert.equal(res.statusCode, 404, `${method} ${routePath} for ${user.id}: ${JSON.stringify(res.body)}`)
        assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED')
      }
    }
    // ...and an under-tier caller is refused by the gate FIRST, switch or no switch.
    assert.equal((await getTarget(h.routes, READ_ONLY)).statusCode, 403)
    assert.equal((await createTarget(h.routes, FLOOR)).statusCode, 403)
    assert.equal((await call(h.routes, 'GET', LIST_PATH, { user: READ_ONLY, query: { tenantId: TENANT } })).statusCode, 403)
    assert.deepEqual(h.provisioning.calls, [], 'no host call')
    assert.deepEqual(h.db.calls, [], 'no registry call')
    assert.deepEqual(h.auditAppends, [], 'no audit row')
    // The conflict-policies list without a project number: the env target, as always.
    const legacy = await policies(h.routes, PLATFORM_ADMIN)
    assert.equal(legacy.statusCode, 200, JSON.stringify(legacy.body))
    assert.deepEqual(h.db.calls, [], 'the registry is never consulted while the switch is off')
  } finally { h.restore() }
})

test('R-02 CREATE: floor refused before IO; puller 201 + registry + audit + G1 with the configured roles; replay 200 idempotent', async () => {
  const grantCalls = []
  const provisioning = makeProvisioning({
    grant: async (input) => { grantCalls.push(input); return { sheetId: input.sheetId, granted: grantCalls.length === 1 ? [...input.roleIds] : [], alreadyGranted: grantCalls.length === 1 ? [] : [...input.roleIds] } },
  })
  const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true', [PROJECT_SHEET_GRANT_ROLE_IDS_ENV]: ` ${ROLE_A}, ${ROLE_B} ,${ROLE_A}` }, provisioning })
  try {
    const refused = await createTarget(h.routes, FLOOR)
    assert.equal(refused.statusCode, 403)
    assert.deepEqual(h.provisioning.calls, [], 'the floor costs no host call')
    assert.deepEqual(h.db.calls, [], 'the floor costs no registry call')

    const created = await createTarget(h.routes, PULLER)
    assert.equal(created.statusCode, 201, JSON.stringify(created.body))
    const objectId = deriveProjectSheetObjectId(TENANT, PROJECT)
    const sheetId = h.provisioning.getObjectSheetId(PROJECT_ID, objectId)
    assert.deepEqual(created.body.data, {
      projectNo: PROJECT, status: 'active', created: true, sheetId, objectId,
      viewId: h.provisioning.getObjectViewId(PROJECT_ID, objectId, STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID),
      todoViewId: h.provisioning.getObjectViewId(PROJECT_ID, objectId, STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID),
      grant: { attempted: true, skipped: null, roleCount: 2, granted: 2, alreadyGranted: 0 },
      // S2 (R-36): this deployment's action declares no ext band and its env object carries no pack,
      // so there is nothing to carry over — the counts say so (the pack suite drives the other case).
      customerPacks: { planned: 0, installed: 0, reinstalled: 0, alreadyInstalled: 0, notInCatalog: 0 },
      todoView: { created: true, skipped: null },
      // S3 fix round 1 (R6): this substrate is an OLDER host (no stamp declaration), so the create's
      // best-effort overview leg refuses before any IO and says so with its closed code — the create stands.
      overview: { ensured: false, created: false, code: 'STOCK_PREPARATION_PROJECT_OVERVIEW_HOST_UNSUPPORTED' },
    })
    assert.equal(h.provisioning.calls.filter((c) => c[0] === 'ensureObject').length, 1, 'ONE sheet provisioned')
    assert.equal(h.provisioning.calls.find((c) => c[0] === 'ensureObject')[1], objectId)
    assert.deepEqual(h.provisioning.calls.filter((c) => c[0] === 'ensureView').map((c) => c[1]), [STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID, STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID])
    assert.equal(h.db.rows.length, 1)
    assert.equal(h.db.rows[0].created_by, 'u_pull')
    assert.deepEqual(grantCalls.map((c) => ({ projectId: c.projectId, sheetId: c.sheetId, objectId: c.objectId, roleIds: c.roleIds, actorId: c.actorId })), [
      { projectId: PROJECT_ID, sheetId, objectId, roleIds: [ROLE_A, ROLE_B], actorId: 'u_pull' },
    ], 'G1 called once with exactly the de-duplicated configured roles, never anything from the request')
    assert.deepEqual(h.auditAppends.map((e) => [e.action, e.projectId, e.subjectId, e.mode, e.actor]), [
      ['project_target_create', PROJECT, sheetId, 'sheet_created', 'u_pull'],
      ['project_target_grant', PROJECT, sheetId, 'granted', 'u_pull'],
    ])
    assert.deepEqual(h.auditAppends[0].detail, { fillViewCreated: true, todoViewCreated: true, ownBaseSource: 'derived' })
    assert.deepEqual(h.auditAppends[1].detail, { roleCount: 2, granted: 2, alreadyGranted: 0 })
    for (const entry of h.auditAppends) {
      assert.ok(!JSON.stringify(entry.detail).includes(ROLE_A), 'role ids never ride the plugin audit detail (the host history carries them)')
    }

    // REPLAY: 200, created:false, no second row, no second sheet, grant re-run and audited.
    h.provisioning.calls.length = 0
    const again = await createTarget(h.routes, PULLER)
    assert.equal(again.statusCode, 200, JSON.stringify(again.body))
    assert.equal(again.body.data.created, false)
    assert.equal(again.body.data.sheetId, sheetId)
    assert.deepEqual(again.body.data.grant, { attempted: true, skipped: null, roleCount: 2, granted: 0, alreadyGranted: 2 })
    assert.deepEqual(again.body.data.customerPacks, { planned: 0, installed: 0, reinstalled: 0, alreadyInstalled: 0, notInCatalog: 0 })
    assert.ok(!('todoView' in again.body.data), 'nothing was provisioned on the replay')
    assert.equal(h.db.rows.length, 1, 'no second row')
    assert.ok(!h.provisioning.calls.some((c) => c[0] === 'ensureObject' || c[0] === 'ensureView'), 'no second sheet, no view rewrite')
    assert.equal(grantCalls.length, 2, 'the grant is re-attempted on a replay (idempotent at the host)')
    assert.deepEqual(h.auditAppends.slice(2).map((e) => [e.action, e.mode]), [['project_target_grant', 'already_granted']], 'a replay audits the grant, not a second create')
    // stock-prep:admin and the platform admin pass the PULL gate through the ladder.
    assert.equal((await createTarget(h.routes, PLATFORM_ADMIN)).statusCode, 200)
  } finally { h.restore() }
})

test('R-03 the cap: 200 registered rows (archived included) refuse the 201st before any provisioning', async () => {
  const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' } })
  try {
    for (let i = 0; i < MAX_PROJECT_TARGETS_PER_TENANT; i += 1) {
      registerActive(h, `PRJ-S1-CAP-${i}`, { archived: i % 2 === 0 })
    }
    h.provisioning.calls.length = 0
    const res = await createTarget(h.routes, PULLER, 'PRJ-S1-CAP-NEW')
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_LIMIT')
    assert.deepEqual({ ...res.body.error.details }, { limit: MAX_PROJECT_TARGETS_PER_TENANT })
    assert.ok(!h.provisioning.calls.some((c) => c[0] === 'ensureObject'), 'nothing provisioned')
    assert.deepEqual(h.auditAppends, [])
    // Another tenant's rows do not count against this tenant.
    const other = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' } })
    try {
      for (let i = 0; i < MAX_PROJECT_TARGETS_PER_TENANT; i += 1) registerActive(other, `PRJ-S1-CAP-${i}`, { tenantId: OTHER_TENANT })
      assert.equal((await createTarget(other.routes, PULLER, 'PRJ-S1-CAP-NEW')).statusCode, 201)
    } finally { other.restore() }
  } finally { h.restore() }
})

test('R-04 archived: create is 409 ARCHIVED; GET reports archived with may.restore by tier', async () => {
  const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' } })
  try {
    const { sheetId } = registerActive(h, PROJECT, { archived: true })
    const res = await createTarget(h.routes, PULLER)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
    assert.ok(!h.provisioning.calls.some((c) => c[0] === 'ensureObject'))
    const asPuller = await getTarget(h.routes, PULLER)
    assert.equal(asPuller.statusCode, 200, JSON.stringify(asPuller.body))
    assert.equal(asPuller.body.data.status, 'archived')
    assert.equal(asPuller.body.data.sheetId, sheetId)
    assert.equal(asPuller.body.data.archivedAt, '2026-10-09T00:00:00.000Z')
    assert.deepEqual(asPuller.body.data.may, { create: false, archive: false, restore: true })
    const asFloor = await getTarget(h.routes, FLOOR)
    assert.equal(asFloor.statusCode, 200)
    assert.deepEqual(asFloor.body.data.may, { create: false, archive: false, restore: false })
  } finally { h.restore() }
})

test('R-05 GET absent: status absent, may.create by tier, no handles, no IO beyond the registry read', async () => {
  const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' } })
  try {
    const asPuller = await getTarget(h.routes, PULLER)
    assert.equal(asPuller.statusCode, 200, JSON.stringify(asPuller.body))
    assert.deepEqual(asPuller.body.data, {
      projectNo: PROJECT, status: 'absent', sheetId: null, viewId: null, todoViewId: null,
      rowCount: null, activeRowCount: null, rowCountBounded: null, lastPulledAt: null, lastPullOutcome: null, archivedAt: null,
      may: { create: true, archive: false, restore: false },
    })
    const asFloor = await getTarget(h.routes, FLOOR)
    assert.deepEqual(asFloor.body.data.may, { create: false, archive: false, restore: false })
    assert.deepEqual(asFloor.body.data.status, 'absent')
    assert.deepEqual(h.provisioning.calls, [], 'an absent project costs no host call')
    assert.deepEqual(h.records.queries, [])
    // The read-only tier is refused: GET is OPERATE.
    assert.equal((await getTarget(h.routes, READ_ONLY)).statusCode, 403)
  } finally { h.restore() }
})

test('R-06 GET active: the handles and the counts from this project\'s sheet', async () => {
  const objectId = deriveProjectSheetObjectId(TENANT, PROJECT)
  const sheetId = `sheet_${PROJECT_ID}_${objectId}`.replace(/[^A-Za-z0-9_]/g, '_')
  const physical = (fieldId) => `fld_${objectId.slice(-6)}_${fieldId}`
  const records = makeRecordsApi({
    [sheetId]: [
      { id: 'r1', data: { [physical('projectNo')]: PROJECT, [physical('active')]: true } },
      { id: 'r2', data: { [physical('projectNo')]: PROJECT, [physical('active')]: true } },
      { id: 'r3', data: { [physical('projectNo')]: PROJECT, [physical('active')]: false } },
    ],
  })
  const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' }, records })
  try {
    registerActive(h)
    const res = await getTarget(h.routes, FLOOR)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.status, 'active')
    assert.equal(res.body.data.sheetId, sheetId)
    assert.equal(res.body.data.viewId, h.provisioning.getObjectViewId(PROJECT_ID, objectId, STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID))
    assert.equal(res.body.data.todoViewId, h.provisioning.getObjectViewId(PROJECT_ID, objectId, STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID))
    assert.equal(res.body.data.rowCount, 3)
    assert.equal(res.body.data.activeRowCount, 2)
    assert.equal(res.body.data.rowCountBounded, false)
    assert.deepEqual(res.body.data.may, { create: false, archive: false, restore: false })
    assert.ok(records.queries.every((q) => q.sheetId === sheetId), 'rows are counted in THIS project\'s sheet only')
    assert.ok(records.queries.every((q) => q.filters[physical('projectNo')] === PROJECT), 'narrowed to this project')
  } finally { h.restore() }
})

test('R-07 LIST: this tenant\'s rows only, handles and enums', async () => {
  const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' } })
  try {
    registerActive(h, 'PRJ-S1-L1')
    registerActive(h, 'PRJ-S1-L2', { archived: true })
    registerActive(h, 'PRJ-S1-L3', { tenantId: OTHER_TENANT })
    const res = await listTargets(h.routes, FLOOR)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.count, 2)
    assert.equal(res.body.data.limit, MAX_PROJECT_TARGETS_PER_TENANT)
    assert.deepEqual(res.body.data.items.map((i) => [i.projectNo, i.status]), [['PRJ-S1-L1', 'active'], ['PRJ-S1-L2', 'archived']])
    // S3 (R-37): the three remaining bounded counts and the last pull's closed code join the item;
    // the response carries the overview's handles (null sheet id until the first refresh created it).
    assert.deepEqual(Object.keys(res.body.data.items[0]).sort(), ['activeRowCount', 'archivedAt', 'countsAt', 'countsBounded', 'createdAt', 'lastPullAt', 'lastPullCode', 'lastPullOutcome', 'missingComponentsCount', 'objectId', 'procurementOpenCount', 'projectNo', 'rowCount', 'sheetId', 'status', 'warehouseOpenCount'])
    // Fix round 1 (R8b): a handle only for a STAMPED overview, and `status` says why there is none —
    // this substrate is an older host, so the lookup refuses before any IO: 'unavailable'.
    assert.deepEqual(Object.keys(res.body.data.overview).sort(), ['activeViewId', 'archivedViewId', 'sheetId', 'status'])
    assert.deepEqual(res.body.data.overview, { status: 'unavailable', sheetId: null, activeViewId: null, archivedViewId: null })
    assert.equal((await listTargets(h.routes, READ_ONLY)).statusCode, 403)
  } finally { h.restore() }
})

test('R-08 conflict-policies, switch ON: no projectNo → 400; unregistered → 409 ABSENT; registered → the project sheet', async () => {
  const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' } })
  try {
    const missing = await policies(h.routes, PLATFORM_ADMIN)
    assert.equal(missing.statusCode, 400, JSON.stringify(missing.body))
    assert.equal(missing.body.error.code, 'STOCK_PREPARATION_PROJECT_NO_REQUIRED')
    const absent = await policies(h.routes, PLATFORM_ADMIN, { projectNo: 'PRJ-S1-NOPE' })
    assert.equal(absent.statusCode, 409)
    assert.equal(absent.body.error.code, 'STOCK_PREPARATION_PROJECT_ABSENT')
    const { sheetId } = registerActive(h)
    const ok = await policies(h.routes, PLATFORM_ADMIN, { projectNo: PROJECT })
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
    assert.ok(h.provisioning.calls.some((c) => c[0] === 'isSheetOwnedByProject' && c[1] === sheetId && c[2] === PROJECT_ID), 'the wall ran on the resolved project sheet')
  } finally { h.restore() }
})

test('R-09 dry-run, switch ON: unregistered → 409 ABSENT, archived → 409 ARCHIVED, before any source read', async () => {
  const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' } })
  try {
    const absent = await dryRun(h.routes, PULLER, 'PRJ-S1-NOPE')
    assert.equal(absent.statusCode, 409, JSON.stringify(absent.body))
    assert.equal(absent.body.error.code, 'STOCK_PREPARATION_PROJECT_ABSENT')
    registerActive(h, 'PRJ-S1-ARCH', { archived: true })
    const archived = await dryRun(h.routes, PULLER, 'PRJ-S1-ARCH')
    assert.equal(archived.statusCode, 409, JSON.stringify(archived.body))
    assert.equal(archived.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
    assert.deepEqual(h.records.queries, [], 'no records IO')
    assert.ok(!h.provisioning.calls.some((c) => c[0] === 'resolveFieldIds'), 'no binding was even built for a refused project')
    // The floor is refused by the S0 pull gate FIRST, before the registry is asked.
    h.db.calls.length = 0
    assert.equal((await dryRun(h.routes, FLOOR, 'PRJ-S1-NOPE')).statusCode, 403)
    assert.deepEqual(h.db.calls, [])
  } finally { h.restore() }
})

test('R-10 the wall: a registered sheet the registry does not attribute to the caller\'s project refuses the dry-run', async () => {
  const provisioning = makeProvisioning({ owned: () => false })
  const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' }, provisioning })
  try {
    // A registry row that names a sheet whose id is NOT the one derived for this project.
    const objectId = deriveProjectSheetObjectId(TENANT, PROJECT)
    h.db.rows.push({ id: 'seed', tenant_id: TENANT, project_no: PROJECT, sheet_id: 'sheet_planted_elsewhere', object_id: objectId, status: 'active', archived_at: null, created_at: new Date() })
    const res = await dryRun(h.routes, PULLER)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'TABLE_ACTION_TARGET_TENANT_MISMATCH')
    assert.deepEqual({ ...res.body.error.details }, { objectId })
    assert.deepEqual(h.records.queries, [], 'refused before any records IO')
  } finally { h.restore() }
})

test('R-11 a G1 refusal after registration surfaces with its status; the replay re-attempts the grant', async () => {
  let attempts = 0
  const provisioning = makeProvisioning({
    grant: async (input) => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('role missing'), { status: 404, code: 'STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_NOT_FOUND', details: { missingRoleIds: [ROLE_A] } })
      return { sheetId: input.sheetId, granted: [...input.roleIds], alreadyGranted: [] }
    },
  })
  const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true', [PROJECT_SHEET_GRANT_ROLE_IDS_ENV]: ROLE_A }, provisioning })
  try {
    const first = await createTarget(h.routes, PULLER)
    assert.equal(first.statusCode, 404, JSON.stringify(first.body))
    assert.equal(first.body.error.code, 'STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_NOT_FOUND')
    assert.equal(h.db.rows.length, 1, 'the sheet IS registered — the grant failed after the fact')
    assert.deepEqual(h.auditAppends.map((e) => e.action), ['project_target_create'], 'no grant audit for a refused grant')
    const replay = await createTarget(h.routes, PULLER)
    assert.equal(replay.statusCode, 200, JSON.stringify(replay.body))
    assert.deepEqual(replay.body.data.grant, { attempted: true, skipped: null, roleCount: 1, granted: 1, alreadyGranted: 0 })
    assert.equal(attempts, 2)
    assert.deepEqual(h.auditAppends.map((e) => e.action), ['project_target_create', 'project_target_grant'])
    // No roles configured: the create still succeeds and reports G2.
    const g2 = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' } })
    try {
      const res = await createTarget(g2.routes, PULLER)
      assert.equal(res.statusCode, 201)
      assert.deepEqual(res.body.data.grant, { attempted: false, skipped: 'no_roles_configured', roleCount: 0, granted: 0, alreadyGranted: 0 })
      assert.deepEqual(g2.auditAppends.map((e) => e.action), ['project_target_create'])
    } finally { g2.restore() }
  } finally { h.restore() }
})

test('R-12 shape: a non-empty create body is 400; a malformed project number is 400; the registry store absent is 501', async () => {
  const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' } })
  try {
    for (const body of [{ baseId: 'base_x' }, { name: 'x' }, { tenantId: TENANT }]) {
      const res = await createTarget(h.routes, PULLER, PROJECT, body)
      assert.equal(res.statusCode, 400, JSON.stringify(res.body))
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_REQUEST_INVALID')
    }
    // The plain-number rule (stock-preparation-common.cjs): a leading dash, an embedded space and an
    // over-long value are outside it; `a/b` and `a.b` are inside it and are not sampled here.
    for (const bad of ['', '  ', '-leading', 'a b', 'x'.repeat(81)]) {
      const res = await createTarget(h.routes, PULLER, bad)
      assert.equal(res.statusCode, 400, `${JSON.stringify(bad)}: ${JSON.stringify(res.body)}`)
      assert.equal((await getTarget(h.routes, PULLER, bad)).statusCode, 400)
    }
    assert.deepEqual(h.provisioning.calls, [])
    assert.deepEqual(h.db.calls, [])
  } finally { h.restore() }
  const noStore = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' }, withStore: false })
  try {
    const res = await createTarget(noStore.routes, PULLER)
    assert.equal(res.statusCode, 501)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_STORE_UNAVAILABLE')
  } finally { noStore.restore() }
})

test('R-13 board, switch ON: an unregistered project renders with no bound target (200), never a 409', async () => {
  const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' } })
  try {
    const res = await call(h.routes, 'GET', BOARD_PATH, { user: FLOOR, params: { projectNo: 'PRJ-S1-NOPE' }, query: { tenantId: TENANT } })
    assert.notEqual(res.statusCode, 409, `the board must catch ABSENT like NOT_CONFIGURED: ${JSON.stringify(res.body)}`)
    assert.ok(res.statusCode === 200 || res.statusCode === 404, `board answered ${res.statusCode}: ${JSON.stringify(res.body)}`)
    if (res.statusCode === 404) {
      assert.notEqual(res.body.error.code, 'STOCK_PREPARATION_PROJECT_ABSENT')
    }
  } finally { h.restore() }
})

// S3 follow-ups 2 (item 5): the fail-closed runner (support/fail-closed-suite-runner.cjs) — the same per-test loop
// and output lines, plus the exit sentinel and the per-test timeout: a hung test can never end this suite with exit 0.
require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-project-target-routes.test.cjs', tests, { passLine: '✓ stock-preparation-project-target-routes' })
