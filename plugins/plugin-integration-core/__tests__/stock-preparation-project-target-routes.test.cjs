'use strict'

const freshProjectWriteLock = () => require('./support/stock-preparation-project-write-lock-kit.cjs').createInMemoryProjectWriteLock({ timers: 'real' }).lock

const { consumableMap } = require('./support/consumable-storage.cjs')

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
const { withRefreshGovernance } = require('./support/stock-preparation-refresh-governance-wiring.cjs')
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
  resolveProjectTargetForAction,
} = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const { ONLINE_READ_PLANS_ENABLED_ENV } = require(path.join(LIB, 'stock-preparation-read-plan-switch.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID, createStockPreparationTableActionRegistry } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE, STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const PLM_SYSTEM_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.filter((field) => field.ownership === 'plm_system').map((field) => field.id)
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

function makeMemoryDb({ serializeTenantTransactions = false } = {}) {
  const rows = []
  const calls = []
  const lockTails = new Map()
  const heldLocks = new Set()
  const matches = (row, where) => Object.entries(where).every(([c, v]) => (row[c] === undefined ? null : row[c]) === (v === undefined ? null : v))
  const api = {
    rows,
    calls,
    heldLocks,
    // E1: the store's create runs lock → count → insert on a transaction handle; this fake runs the
    // callback inline (no isolation) and records the lock so a suite can see it was taken.
    async transaction(fn) {
      calls.push('transaction')
      const releases = []
      try {
        return await fn({
          ...api,
          async setTransactionIsolationLevel(level) { calls.push(`setTransactionIsolationLevel:${level}`) },
          async tryAdvisoryXactLock(key) {
            calls.push(`tryAdvisoryXactLock:${key}`)
            if (serializeTenantTransactions && heldLocks.has(key)) return false
            if (serializeTenantTransactions) {
              heldLocks.add(key)
              releases.push(() => { heldLocks.delete(key) })
            }
            return true
          },
          async advisoryXactLock(key) {
            if (serializeTenantTransactions) {
              const prior = lockTails.get(key) || Promise.resolve()
              let release
              const tail = new Promise((resolve) => { release = resolve })
              lockTails.set(key, tail)
              await prior
              heldLocks.add(key)
              releases.push(() => {
                heldLocks.delete(key)
                release()
                if (lockTails.get(key) === tail) lockTails.delete(key)
              })
            }
            calls.push(`advisoryXactLock:${key}`)
          },
        })
      } finally { for (const release of releases.reverse()) release() }
    },
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
    // G1 field defect (R67): the create path writes the contract option set onto the new sheet's decision column.
    async patchObjectFieldProperty({ projectId, objectId, fieldId, propertyPatch }) {
      calls.push(['patchObjectFieldProperty', objectId, fieldId])
      return { id: api.getFieldId(projectId, objectId, fieldId), sheetId: sheetIdOf(projectId, objectId), name: fieldId, type: 'select', property: propertyPatch, order: 0 }
    },
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
    // Batch-refresh phase 0 step 1: apply holds the project write lease (fails closed 501 without the lock).
    stockPreparationProjectWriteLock: freshProjectWriteLock(),
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
    // Explicitly no activation pointer on this synthetic scope; an absent runtime is not legacy.
    stockPreparationReadPlanStore: { async getActiveForRuntime() { return null }, async getActivation() { return null } },
  }
}

function mount({ env = {}, provisioning = makeProvisioning(), records = makeRecordsApi(), db = makeMemoryDb(), withStore = true, configExtras = {}, serviceExtras = {} } = {}) {
  const routes = new Map()
  const auditAppends = []
  const context = {
    api: {
      http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } },
      multitable: { provisioning, records: require('./support/stock-preparation-project-write-lock-kit.cjs').withFakeHostWriteFence(records) },
    },
    // `durable: true` is what the large-BOM job store demands before it accepts a job (R-14..R-16).
    storage: consumableMap(),
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
  for (const key of [PROJECT_SHEETS_ENABLED_ENV, PROJECT_SHEET_GRANT_ROLE_IDS_ENV, 'MULTITABLE_STOCK_PREP_OWN_BASE', 'MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED', ONLINE_READ_PLANS_ENABLED_ENV]) {
    previousEnv[key] = process.env[key]
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
  // PR-3a: the real refresh governance, unless the case names its own service (even null: the unwired leg).
  const wired = Object.prototype.hasOwnProperty.call(serviceExtras, 'stockPreparationRefreshGovernance') ? services : withRefreshGovernance(services)
  httpRoutes.registerIntegrationRoutes({ context, services: wired, logger: { info() {}, warn() {}, error() {} } })
  return {
    routes, auditAppends, provisioning, records, db, store, context,
    refresh: services.refreshGovernanceEnv || null,
    projectWriteLock: services.stockPreparationProjectWriteLock || null,
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
 * Resolve the actual deployment/project action, then run the real enqueue → expansion → plan
 * producers over a synthetic empty source. They alone mint evaluation identity and artifact/plan
 * revisions. Empty decisions keep these cases about WHICH sheet the job addresses, not its rows.
 */
const swlLockLib = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))

async function seedPlannedExpansionJob(h, { jobId, target, projectNo = PROJECT }) {
  const actionId = PLM_STOCK_PREPARATION_ACTION_ID
  const at = '2026-10-09T00:00:00.000Z'
  // Codex review P1-b: a seeded expansion + plan carries what the routes record — the target sheet's write
  // generation observed from the mounted lock (none when no lock service is wired).
  const seedLock = h.projectWriteLock
  const writeObservation = seedLock && target && typeof target.sheetId === 'string'
    ? swlLockLib.writeObservationFromGeneration(await seedLock.observeGeneration(swlLockLib.sheetWriteScopeKey(target.sheetId)))
    : null
  const registry = createStockPreparationTableActionRegistry({
    actions: h.context.config.stockPreparationTableActions,
    resolveProjectTarget: (input) => resolveProjectTargetForAction({
      ...input, store: h.store, provisioning: h.provisioning, projectId: PROJECT_ID, env: process.env,
    }),
  })
  const action = await registry.getTableAction({ ...JOB_SCOPE, actionId, projectNo, targetPurpose: 'write' })
  assert.equal(action.target.sheetId, target.sheetId, 'producer uses the actual resolved sheet')
  assert.equal(action.target.objectId, target.objectId, 'producer uses the actual resolved object')
  await largeBomJobs.createLargeBomBackgroundExpansionJob({
    storage: h.context.storage, ...JOB_SCOPE, action,
    parameters: { projectNo },
    principal: PULLER.id, actor: PULLER.id, createJobId: () => jobId, now: () => at,
  })
  let reads = 0
  const expanded = await largeBomJobs.runLargeBomBackgroundExpansionJob({
    storage: h.context.storage, ...JOB_SCOPE, actionId, jobId, now: () => at,
    sourceAdapter: {
      async read(input) {
        reads += 1
        assert.equal(input.object, 'DN_PDM_PathExAttrInfo')
        assert.deepEqual(input.filters, { FileCode: projectNo })
        return { records: [], done: true, nextCursor: null, metadata: { filtersApplied: true } }
      },
    },
  })
  assert.equal(reads, 1, 'the real expander read the synthetic source')
  assert.equal(expanded.status, 'completed')
  largeBomJobs.assertAuthoritativeLargeBomExpansion(expanded)
  assert.deepEqual(expanded.artifact.rows, [])
  // Independent negative controls: neither producer identity may be omitted, even when the
  // other identity and the computed revision are intact. Never backfill a fixture stamp.
  const noJobIdentity = { ...expanded }
  delete noJobIdentity.bomEvaluationVersion
  const noArtifactIdentity = { ...expanded, artifact: { ...expanded.artifact } }
  delete noArtifactIdentity.artifact.bomEvaluationVersion
  for (const stale of [noJobIdentity, noArtifactIdentity]) {
    assert.throws(() => largeBomJobs.assertAuthoritativeLargeBomExpansion(stale),
      (error) => error.code === 'LARGE_BOM_ARTIFACT_NOT_AUTHORITATIVE')
  }
  const planned = await largeBomJobs.planLargeBomBackgroundExpansionJob({
    storage: h.context.storage, ...JOB_SCOPE, actionId, jobId, existingRows: [], plannedAt: at,
  })
  largeBomJobs.assertAuthoritativeLargeBomPlan(planned)
  assert.deepEqual(planned.planArtifact.plan.decisions, [])
  if (!writeObservation) return planned
  // The producers ran outside the routes, so the write generation the routes would have recorded is stamped
  // onto the stored job — only that; the producer-minted identity and revisions stay exactly as minted.
  const jobKey = largeBomJobs.__internals.backgroundJobKey({ ...JOB_SCOPE, actionId, jobId })
  const stored = await h.context.storage.get(jobKey)
  assert.equal(stored && stored.jobId, jobId, 'the planned job is stored under its background-job key')
  const observed = { ...stored, writeObservation, planWriteObservation: writeObservation }
  await h.context.storage.set(jobKey, observed)
  return observed
}

const jobParams = (jobId, applyJobId) => ({ actionId: PLM_STOCK_PREPARATION_ACTION_ID, jobId, ...(applyJobId ? { applyJobId } : {}) })
const plan = (routes, jobId) => call(routes, 'POST', PLAN_PATH, { user: PLATFORM_ADMIN, params: jobParams(jobId), body: {}, query: { tenantId: TENANT } })
const applyStart = (routes, jobId) => call(routes, 'POST', APPLY_START_PATH, { user: PLATFORM_ADMIN, params: jobParams(jobId), body: { confirm: { acceptManualConfirmHold: true } }, query: { tenantId: TENANT } })
const applyRun = (routes, jobId, applyJobId) => call(routes, 'POST', APPLY_RUN_PATH, { user: PLATFORM_ADMIN, params: jobParams(jobId, applyJobId), body: {}, query: { tenantId: TENANT } })
const ENV_TARGET = Object.freeze({ sheetId: ENV_SHEET, objectId: ENV_OBJECT, fieldIdMap: {} })

const tests = []
const test = (name, fn) => tests.push([name, fn])

// P2 registration regressions: actual route, registry and registration metadata resolver.
// Persisted approved versions are synthetic status fixtures; these tests do not mint execution
// capability, source validation, or claim requirements from the read-only metadata.
function registrationAction(comparison) {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly',
      ...(comparison === undefined ? {} : { readPlan: activeRegistrationPlan(comparison).version.config.readPlan }) },
    target: { sheetId: ENV_SHEET, objectId: ENV_OBJECT, fieldIdMap: {} },
  }
}

function activeRegistrationPlan(comparison) {
  const { validateStockPreparationReadPlanConfig } = require('../lib/stock-preparation-read-plan-config.cjs')
  const config = validateStockPreparationReadPlanConfig({
    schemaVersion: 1, actionId: PLM_STOCK_PREPARATION_ACTION_ID, systemId: 'plm_sql_source',
    readPlan: {
      id: 'plm.stock-preparation.bom-read.user-draft.v1', sourceKind: 'data-source:sql-readonly', matchField: 'project', maxReadCount: 100,
      pathExAttr: { object: 'SYN_PathLink', matchField: 'project', pathIdField: 'path' },
      pathInfo: { object: 'SYN_Path', idField: 'id' },
      orderHead: { object: 'SYN_Order', idField: 'id', pathIdField: 'path' },
      orderDetail: { object: 'SYN_OrderLine', orderIdField: 'order', componentIdField: 'part', quantityField: 'qty' },
      part: { object: 'SYN_Part', idField: 'id', codeField: 'code', nameField: 'name' },
      bomHead: { object: 'SYN_Bom', parentPartField: 'part', bomIdField: 'id' },
      bomDetail: { object: 'SYN_BomLine', bomParentField: 'bom', componentIdField: 'part', quantityField: 'qty' },
      ...(comparison === undefined ? {} : { sourceProjectComparison: comparison }),
    },
  })
  const stable = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value)
    : Array.isArray(value) ? `[${value.map(stable).join(',')}]`
      : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  const contentKey = require('node:crypto').createHash('sha256').update(stable(config)).digest('hex')
  const scope = { tenantId: TENANT, workspaceId: null }
  return {
    activation: { ...scope, id: 'synthetic-registration-pointer', status: 'active', actionId: config.actionId, systemId: config.systemId, versionId: 'synthetic-registration-version', contentKey, generation: 1 },
    version: { ...scope, id: 'synthetic-registration-version', status: 'approved', schemaVersion: 1, version: 1, actionId: config.actionId, systemId: config.systemId, contentKey, config },
    sourceValidation: { connectionId: 'synthetic-registration-connection', connectionRevision: '11111111-1111-4111-8111-111111111111', bindingRevision: '22222222-2222-4222-8222-222222222222' },
  }
}

function registrationMount({ comparison = 'case-insensitive', active, ...options } = {}) {
  const planCalls = []
  const executionCalls = []
  const h = mount({
    ...options,
    // Online read plans ON for these registration cases; P2-R14 turns the switch off explicitly.
    env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true', [PROJECT_SHEET_GRANT_ROLE_IDS_ENV]: JSON.stringify([ROLE_A, ROLE_B]), [ONLINE_READ_PLANS_ENABLED_ENV]: 'true', ...options.env },
    configExtras: { stockPreparationTableActions: [registrationAction(comparison)], ...options.configExtras },
    serviceExtras: {
      stockPreparationReadPlanStore: {
        async getActiveForRuntime(input) { executionCalls.push(input); return active ? structuredClone(active) : null },
        async getActivation(input) { planCalls.push(['activation', input]); return active && input.workspaceId === active.activation.workspaceId ? structuredClone(active.activation) : null },
        async getForRuntime(input) { planCalls.push(['version', input]); assert.ok(active, 'an active metadata version is required'); return structuredClone(active.version) },
      },
      ...options.serviceExtras,
    },
  })
  h.planCalls = planCalls
  h.executionCalls = executionCalls
  return h
}

function registrationBindings(scopes = [null, 'workspace-synthetic']) {
  const { createStockPreparationSourceBindingStore, BINDING_TABLE } = require('../lib/stock-preparation-source-binding-store.cjs')
  const rows = scopes.map((workspaceId) => ({ tenant_id: TENANT, workspace_id: workspaceId,
    action_id: PLM_STOCK_PREPARATION_ACTION_ID, external_system_id: 'plm_sql_source' }))
  const calls = []
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const db = {
    async selectOne(table, where) { assert.equal(table, BINDING_TABLE); calls.push(['get', where]); return rows.find((row) => matches(row, where)) || null },
    async select(table, { where, limit } = {}) { assert.equal(table, BINDING_TABLE); calls.push(['list', where]); return rows.filter((row) => matches(row, where)).slice(0, limit) },
    async insertOne() { throw new Error('unexpected synthetic binding write') },
    async updateRow() { throw new Error('unexpected synthetic binding write') },
    async transaction(fn) { return fn(db) },
    async selectOneForKeyShare() { throw new Error('unexpected synthetic binding write') },
  }
  // F2: under the registry lock the comparison lists the bindings on the REGISTRY's transaction handle. One database:
  // `servedBy(trx)` is that handle reading this table too (recorded 'trx-list'); every other table stays the registry's.
  const servedBy = (trx) => ({
    ...trx,
    async select(table, options = {}) {
      if (table !== BINDING_TABLE) return trx.select(table, options)
      calls.push(['trx-list', options.where])
      return rows.filter((row) => matches(row, options.where)).slice(0, options.limit)
    },
  })
  return { store: createStockPreparationSourceBindingStore({ db }), calls, servedBy }
}

const registerProject = (h, projectNo, { user = PULLER, body = {}, query = {}, claim = true } = {}) => call(h.routes, 'POST', CREATE_PATH, {
  user, authenticatedTenantId: claim ? user.tenantId : undefined, params: { projectNo }, body, query,
})
const assertRegistrationRefusedWithoutWrites = (h, response, before, code, status = 409) => {
  assert.equal(response.statusCode, status, JSON.stringify(response.body))
  assert.equal(response.body.error.code, code)
  assert.equal(h.db.rows.length, before.rows, 'no registry insert')
  assert.equal(h.provisioning.calls.length, before.host, 'no provisioning, field, view, pack or grant host call')
  assert.equal(h.auditAppends.length, before.audit, 'no success audit')
  assert.doesNotMatch(JSON.stringify(response.body), /synthetic-private|Abc|abc/, 'refusal does not echo project identity or private driver text')
}
const registrationSnapshot = (h) => ({ rows: h.db.rows.length, host: h.provisioning.calls.length, audit: h.auditAppends.length })

test('P2-R01 case-insensitive registration refuses active and archived variants before host writes; exact replay remains unchanged', async () => {
  for (const archived of [false, true]) {
    const h = registrationMount()
    try {
      registerActive(h, 'Abc', { archived })
      const before = registrationSnapshot(h)
      const result = await registerProject(h, 'abc')
      assertRegistrationRefusedWithoutWrites(h, result, before, 'STOCK_PREPARATION_PROJECT_IDENTITY_CONFLICT')
      assert.deepEqual({ ...result.body.error.details }, { field: 'projectNo' })
      if (!archived) {
        const replay = await registerProject(h, 'Abc')
        assert.equal(replay.statusCode, 200, JSON.stringify(replay.body))
        assert.equal(replay.body.data.created, false)
        assert.equal(h.db.rows.length, 1)
        assert.ok(h.provisioning.calls.some((entry) => entry[0] === 'grantSheetRoleWrite'), 'unchanged exact replay heals its grant')
        assert.equal(h.provisioning.calls.filter((entry) => entry[0] === 'ensureObject').length, 0, 'replay provisions no second project sheet')
      } else {
        assertRegistrationRefusedWithoutWrites(h, await registerProject(h, 'Abc'), before, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
      }
    } finally { h.restore() }
  }
})

test('P2-R02 absent and case-sensitive comparison allow variants; another tenant does not conflict', async () => {
  for (const comparison of [null, 'case-sensitive', 'case-insensitive']) {
    const h = registrationMount({ comparison: comparison === null ? undefined : comparison,
      ...(comparison === null ? { configExtras: { stockPreparationTableActions: [registrationAction(undefined)] } } : {}) })
    try {
      registerActive(h, 'Abc', { tenantId: comparison === 'case-insensitive' ? OTHER_TENANT : TENANT })
      const result = await registerProject(h, 'abc')
      assert.equal(result.statusCode, 201, JSON.stringify(result.body))
      assert.equal(h.db.rows.length, 2)
      assert.equal(h.db.rows[1].project_no, 'abc', 'case is preserved rather than normalized')
      assert.equal(h.db.rows[1].tenant_id, TENANT)
    } finally { h.restore() }
  }
})

test('P2-R03 online CI tightens deployment CS while deployment CI cannot be weakened by online CS or default', async () => {
  for (const [deployment, online, status] of [
    ['case-sensitive', 'case-insensitive', 409],
    ['case-insensitive', 'case-sensitive', 409],
    ['case-insensitive', undefined, 409],
  ]) {
    const h = registrationMount({ comparison: deployment, active: activeRegistrationPlan(online) })
    try {
      registerActive(h, 'Abc')
      const before = registrationSnapshot(h)
      const result = await registerProject(h, 'abc')
      if (status === 409) assertRegistrationRefusedWithoutWrites(h, result, before, 'STOCK_PREPARATION_PROJECT_IDENTITY_CONFLICT')
      else assert.equal(result.statusCode, 201, JSON.stringify(result.body))
      if (deployment !== 'case-insensitive') {
        assert.ok(h.planCalls.some(([method]) => method === 'version'), 'the approved metadata version is resolved')
        assert.deepEqual(h.planCalls[0], ['activation', { tenantId: TENANT, workspaceId: null, actionId: PLM_STOCK_PREPARATION_ACTION_ID }])
      }
    } finally { h.restore() }
  }
})

test('P2-R04 request body cannot override registration comparison', async () => {
  const h = registrationMount()
  try {
    registerActive(h, 'Abc')
    for (const body of [{ sourceProjectComparison: 'case-sensitive' }, { source: { readPlan: { sourceProjectComparison: 'case-sensitive' } } }]) {
      const before = registrationSnapshot(h)
      const result = await registerProject(h, 'abc', { body })
      assert.equal(result.statusCode, 400, JSON.stringify(result.body))
      assert.equal(h.provisioning.calls.length, before.host)
      assert.equal(h.db.rows.length, before.rows)
    }
    const before = registrationSnapshot(h)
    assertRegistrationRefusedWithoutWrites(h, await registerProject(h, 'abc'), before, 'STOCK_PREPARATION_PROJECT_IDENTITY_CONFLICT')
  } finally { h.restore() }
})

test('P2-R05 malformed, truncated and unavailable transaction registry reads fail closed before provisioning', async () => {
  const cases = [
    ['malformed row', (trx) => ({ ...trx, async select() { return [{ tenant_id: TENANT, project_no: 7, status: 'active' }] } })],
    ['truncated rows', (trx) => ({ ...trx, async select() { return [] } })],
    ['unavailable rows', (trx) => ({ ...trx, async select() { throw new Error('synthetic-private-registry') } })],
    ['invalid count', (trx) => ({ ...trx, async countRows() { return '1' } })],
    ['invalid empty result', (trx) => ({ ...trx, async countRows() { return 0 }, async select() { return {} } })],
    ['missing tenant', (trx) => ({ ...trx, async select() { return [{ project_no: 'Other', sheet_id: 's', object_id: 'o', status: 'active' }] } })],
    ['noncanonical project', (trx) => ({ ...trx, async select() { return [{ tenant_id: TENANT, project_no: ' Other ', sheet_id: 's', object_id: 'o', status: 'active' }] } })],
  ]
  for (const [label, alter] of cases) {
    const db = makeMemoryDb()
    const original = db.transaction
    db.transaction = (fn) => original((trx) => fn(alter(trx)))
    const h = registrationMount({ db })
    try {
      registerActive(h, 'Other')
      const before = registrationSnapshot(h)
      const result = await registerProject(h, 'abc')
      assert.equal(result.statusCode, 503, `${label}: ${JSON.stringify(result.body)}`)
      assert.equal(result.body.error.code, 'STOCK_PREPARATION_PROJECT_IDENTITY_UNAVAILABLE', label)
      assert.equal(h.provisioning.calls.length, before.host, `${label}: no host work`)
      assert.equal(h.db.rows.length, before.rows, `${label}: no row`)
      assert.doesNotMatch(JSON.stringify(result.body), /synthetic-private/)
    } finally { h.restore() }
  }
})

test('P2-R06 unavailable or invalid registration metadata refuses instead of deployment fallback', async () => {
  const invalid = activeRegistrationPlan('case-insensitive')
  invalid.version.contentKey = '0'.repeat(64)
  for (const [service, status, code] of [
    [undefined, 503, 'STOCK_PREPARATION_PROJECT_IDENTITY_UNAVAILABLE'],
    [{ async getActivation() { throw new Error('synthetic-private-plan') } }, 503, 'STOCK_PREPARATION_PROJECT_IDENTITY_UNAVAILABLE'],
    [{ async getActivation() { return invalid.activation }, async getForRuntime() { return invalid.version } }, 503, 'STOCK_PREPARATION_PROJECT_IDENTITY_UNAVAILABLE'],
  ]) {
    const h = registrationMount({ comparison: 'case-sensitive', serviceExtras: { stockPreparationReadPlanStore: service } })
    try {
      assertRegistrationRefusedWithoutWrites(h, await registerProject(h, 'abc'), { rows: 0, host: 0, audit: 0 }, code, status)
    } finally { h.restore() }
  }
})

test('P2-R07 concurrent case variants return BUSY before provisioning; retry rejects the committed case variant', async () => {
  // This deterministic in-memory mutex models transaction-scoped advisory locking. It is NOT
  // PostgreSQL isolation proof. The two real route handlers, store and resolver still run.
  const db = makeMemoryDb({ serializeTenantTransactions: true })
  const provisioning = makeProvisioning()
  const ensureObject = provisioning.ensureObject
  const projectIds = new Set(['Abc', 'abc'].map((projectNo) => deriveProjectSheetObjectId(TENANT, projectNo)))
  let projectHostWrites = 0
  provisioning.ensureObject = async (input) => {
    if (projectIds.has(input.descriptor.id)) {
      projectHostWrites += 1
      assert.ok(db.heldLocks.has(`stock-prep-project-target:${TENANT}`), 'tenant lock is held before first project host write')
      await new Promise((resolve) => setImmediate(resolve))
    }
    return ensureObject(input)
  }
  const h = registrationMount({ db, provisioning })
  try {
    const results = await Promise.all([registerProject(h, 'Abc'), registerProject(h, 'abc')])
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [201, 409])
    const loserIndex = results.findIndex((result) => result.statusCode === 409)
    assert.equal(results[loserIndex].body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_BUSY')
    assert.equal(projectHostWrites, 1, 'one project sheet is provisioned; overview sheets are separate')
    assert.equal(h.db.rows.length, 1)
    assert.equal(db.heldLocks.size, 0, 'the transaction releases its lock after completion')
    const before = registrationSnapshot(h)
    const retry = await registerProject(h, ['Abc', 'abc'][loserIndex])
    assertRegistrationRefusedWithoutWrites(h, retry, before, 'STOCK_PREPARATION_PROJECT_IDENTITY_CONFLICT')
  } finally { h.restore() }
})

test('P2-R08 legacy ambiguity refuses exact replay before grant or pack healing through the real route', async () => {
  for (const archived of [false, true]) {
    const h = registrationMount({ comparison: 'case-sensitive', active: activeRegistrationPlan('case-insensitive') })
    try {
      registerActive(h, 'Abc')
      registerActive(h, 'abc', { archived })
      const before = registrationSnapshot(h)
      const result = await registerProject(h, 'Abc')
      assertRegistrationRefusedWithoutWrites(h, result, before, 'STOCK_PREPARATION_PROJECT_IDENTITY_CONFLICT')
      assert.deepEqual({ ...result.body.error.details }, { field: 'projectNo' })
      assert.ok(h.planCalls.length > 0, 'exact replay uses its effective online comparison under the store lock')
      assert.equal(h.db.rows[1].status, archived ? 'archived' : 'active')
    } finally { h.restore() }
  }
})

test('P2-R09 real binding enumeration finds CI in tenant-null and sibling workspace scopes', async () => {
  for (const workspaceId of [null, 'workspace-synthetic']) {
    const binding = registrationBindings()
    const active = activeRegistrationPlan('case-insensitive')
    active.activation.workspaceId = workspaceId
    active.version.workspaceId = workspaceId
    delete active.sourceValidation
    // One database (F2): the registry transaction the comparison reads on under the lock serves the binding table too.
    const db = makeMemoryDb()
    const original = db.transaction
    db.transaction = (fn) => original((trx) => fn(binding.servedBy(trx)))
    const h = registrationMount({ comparison: 'case-sensitive', active, db,
      serviceExtras: { stockPreparationSourceBindingStore: binding.store } })
    try {
      registerActive(h, 'Abc')
      const before = registrationSnapshot(h)
      assertRegistrationRefusedWithoutWrites(h, await registerProject(h, 'abc'), before, 'STOCK_PREPARATION_PROJECT_IDENTITY_CONFLICT')
      const probed = h.planCalls.filter(([method]) => method === 'activation').map(([, input]) => input.workspaceId)
      assert.ok(probed.includes(null), 'tenant-null pointer is never hidden by a workspace binding')
      assert.ok(probed.includes('workspace-synthetic'), 'all real binding scopes are checked')
      assert.ok(binding.calls.some(([method]) => method === 'list'), 'actual listForAction participates')
      assert.ok(binding.calls.some(([method]) => method === 'trx-list'), 'under the registry lock the bindings are listed on its transaction (F2)')
      assert.equal(h.executionCalls.length, 0, 'registration metadata does not consult execution validation')
    } finally { h.restore() }
  }
})

test('P2-R10 create query selectors are refused before registry, metadata, binding or host IO', async () => {
  const binding = registrationBindings()
  const h = registrationMount({ comparison: 'case-sensitive', serviceExtras: { stockPreparationSourceBindingStore: binding.store } })
  try {
    for (const query of [{ workspaceId: 'workspace-synthetic' }, { tenantId: TENANT }, { sourceProjectComparison: 'case-sensitive' }]) {
      const before = registrationSnapshot(h)
      const result = await registerProject(h, 'abc', { query })
      assert.equal(result.statusCode, 400, JSON.stringify(result.body))
      assert.equal(h.db.calls.length, 0)
      assert.equal(h.planCalls.length, 0)
      assert.equal(binding.calls.length, 0)
      assert.equal(h.provisioning.calls.length, before.host)
      assert.equal(h.auditAppends.length, before.audit)
    }
  } finally { h.restore() }
})

test('P2-R11 registration and repair use directory membership without execution claim or source validation', async () => {
  for (const comparison of ['case-sensitive', 'case-insensitive']) {
    const active = activeRegistrationPlan(comparison)
    delete active.sourceValidation
    const h = registrationMount({ comparison, active, env: { MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED: 'true' } })
    try {
      const created = await registerProject(h, 'Abc', { claim: false })
      assert.equal(created.statusCode, 201, JSON.stringify(created.body))
      const repaired = await registerProject(h, 'Abc', { claim: false })
      assert.equal(repaired.statusCode, 200, JSON.stringify(repaired.body))
      assert.equal(repaired.body.data.created, false)
      assert.equal(h.db.rows.length, 1)
      assert.equal(h.executionCalls.length, 0, 'no full runtime getter or source validation is consulted')
    } finally { h.restore() }
  }
})

test('P2-R12 default and CS create retain legacy concurrency and provision outside the registry transaction lock', async () => {
  for (const comparison of [undefined, 'case-sensitive']) {
    for (const projects of [['Abc', 'Other'], ['Abc', 'Abc']]) {
      const db = makeMemoryDb({ serializeTenantTransactions: true })
      const provisioning = makeProvisioning()
      const ensureObject = provisioning.ensureObject
      const projectIds = new Set(projects.map((projectNo) => deriveProjectSheetObjectId(TENANT, projectNo)))
      let prepared = 0
      provisioning.ensureObject = async (input) => {
        if (projectIds.has(input.descriptor.id)) {
          assert.equal(db.heldLocks.size, 0, 'legacy project provisioning is outside a registry transaction lock')
          prepared += 1
          await new Promise((resolve) => setImmediate(resolve))
        }
        return ensureObject(input)
      }
      const h = registrationMount({ comparison, db, provisioning,
        ...(comparison === undefined ? { configExtras: { stockPreparationTableActions: [registrationAction(undefined)] } } : {}) })
      try {
        const results = await Promise.all(projects.map((projectNo) => registerProject(h, projectNo)))
        const sameProject = projects[0] === projects[1]
        assert.deepEqual(results.map((result) => result.statusCode).sort(), sameProject ? [201, 409] : [201, 201])
        if (sameProject) assert.equal(results.find((result) => result.statusCode === 409).body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_EXISTS')
        assert.equal(prepared, 2)
        assert.equal(h.db.rows.length, sameProject ? 1 : 2)
        assert.ok(!db.calls.some((value) => value.startsWith('tryAdvisoryXactLock:')), 'default / case-sensitive create never takes the non-blocking lock (no BUSY)')
        const pinAt = db.calls.indexOf('setTransactionIsolationLevel:read committed')
        const lockAt = db.calls.indexOf(`advisoryXactLock:stock-prep-project-target:${TENANT}`)
        assert.ok(pinAt !== -1 && lockAt > pinAt, 'it pins READ COMMITTED, then takes the BLOCKING tenant lock to re-resolve the comparison')
      } finally { h.restore() }
    }
  }
})

test('P2-R13 default/CS create re-resolves the comparison under the blocking lock: a case-insensitive activation committed during provisioning refuses the variant', async () => {
  const db = makeMemoryDb({ serializeTenantTransactions: true })
  const provisioning = makeProvisioning()
  const ensureObject = provisioning.ensureObject
  const variantObjectId = deriveProjectSheetObjectId(TENANT, 'abc')
  let activated = false
  provisioning.ensureObject = async (input) => {
    // The case-insensitive activation commits after the route's pre-read, while the variant's sheet is provisioned.
    if (input.descriptor.id === variantObjectId) activated = true
    return ensureObject(input)
  }
  const online = activeRegistrationPlan('case-insensitive')
  const h = registrationMount({ comparison: 'case-sensitive', db, provisioning, serviceExtras: {
    stockPreparationReadPlanStore: {
      async getActiveForRuntime() { return null },
      async getActivation(input) { return activated && input.workspaceId === null ? structuredClone(online.activation) : null },
      async getForRuntime() { return structuredClone(online.version) },
    },
  } })
  try {
    registerActive(h, 'Abc')
    const before = registrationSnapshot(h)
    const result = await registerProject(h, 'abc')
    assert.equal(result.statusCode, 409, JSON.stringify(result.body))
    assert.equal(result.body.error.code, 'STOCK_PREPARATION_PROJECT_IDENTITY_CONFLICT')
    assert.ok(activated, 'the pre-read saw case-sensitive; the activation landed during provisioning')
    assert.equal(h.db.rows.length, before.rows, 'the variant is not registered')
    assert.equal(h.auditAppends.length, before.audit, 'no success audit')
    assert.ok(h.provisioning.calls.length > before.host, 'documented race residue: the default leg provisioned outside the lock before the re-check')
    assert.ok(!db.calls.some((value) => value.startsWith('tryAdvisoryXactLock:')), 'still the blocking lock, never BUSY')
    assert.doesNotMatch(JSON.stringify(result.body), /Abc|abc/, 'the refusal echoes no project identity')
    // A retry of the same spelling now pre-reads case-insensitive and is refused before any host write.
    const retryBefore = registrationSnapshot(h)
    assertRegistrationRefusedWithoutWrites(h, await registerProject(h, 'abc'), retryBefore, 'STOCK_PREPARATION_PROJECT_IDENTITY_CONFLICT')
  } finally { h.restore() }
})

test('P2-R14 online read plans switched OFF: registration uses the deployment comparison only and reads no online pointer', async () => {
  for (const [deployment, expected] of [['case-sensitive', 201], ['case-insensitive', 409]]) {
    const h = registrationMount({ comparison: deployment, active: activeRegistrationPlan('case-insensitive'),
      env: { [ONLINE_READ_PLANS_ENABLED_ENV]: undefined } })
    try {
      registerActive(h, 'Abc')
      const before = registrationSnapshot(h)
      const result = await registerProject(h, 'abc')
      if (expected === 201) {
        assert.equal(result.statusCode, 201, `${deployment}: an online case-insensitive plan cannot execute while the switch is off`)
        assert.equal(h.db.rows.length, before.rows + 1)
      } else {
        assertRegistrationRefusedWithoutWrites(h, result, before, 'STOCK_PREPARATION_PROJECT_IDENTITY_CONFLICT')
      }
      assert.deepEqual(h.planCalls, [], `${deployment}: no activation pointer or version is read while the switch is off`)
    } finally { h.restore() }
  }
})

test('P2-R15 (F2) the pool is exhausted while the registry lock is held: strict create, pinned default / case-sensitive create and strict replay still register — every comparison read under the lock rides the registry transaction', async () => {
  // A connection-starved pool, modelled: while a registry transaction holds the tenant lock, a comparison read that is
  // NOT handed that transaction finds no free connection and fails (the host pool's connect timeout, without its 10 s
  // wait: blocking takers of the same lock each hold a pooled connection while they wait). A read handed the
  // transaction runs on its connection. Without F2 each leg below answered 503 STOCK_PREPARATION_PROJECT_IDENTITY_UNAVAILABLE.
  const online = activeRegistrationPlan('case-insensitive')
  for (const [leg, status, lockedKinds] of [
    ['strict-create', 201, ['activation', 'bindings', 'version', 'bindings', 'activation']],
    ['pinned-create', 201, ['activation', 'bindings', 'bindings', 'activation']],
    ['strict-replay', 200, ['activation', 'bindings', 'version', 'bindings', 'activation']],
  ]) {
    const db = makeMemoryDb({ serializeTenantTransactions: true })
    const transactions = new Set()
    const original = db.transaction
    db.transaction = (fn) => original((trx) => { transactions.add(trx); return fn(trx) })
    const strict = leg !== 'pinned-create'
    const reads = []
    const read = (kind, options) => {
      const executor = options && options.executor
      const locked = db.heldLocks.size > 0
      reads.push({ kind, on: executor ? (transactions.has(executor) ? 'registry-transaction' : 'foreign-handle') : 'pool', locked })
      if (!executor && locked) throw new Error('synthetic-private-pool-exhausted')
    }
    const h = registrationMount({ comparison: 'case-sensitive', db, serviceExtras: {
      stockPreparationReadPlanStore: {
        async getActiveForRuntime() { return null },
        // strict legs: an online case-insensitive plan is active at the tenant-null scope; pinned: no pointer anywhere.
        async getActivation(input, options) { read('activation', options); return strict && input.workspaceId === null ? structuredClone(online.activation) : null },
        async getForRuntime(_input, options) { read('version', options); return structuredClone(online.version) },
      },
      stockPreparationSourceBindingStore: {
        async get() { return null },
        async set() { throw new Error('unexpected synthetic binding write') },
        async listForAction(_input, options) { read('bindings', options); return { bindings: [], complete: true } },
      },
    } })
    try {
      if (leg === 'strict-replay') registerActive(h, 'Abc')
      const result = await registerProject(h, 'Abc')
      assert.equal(result.statusCode, status, `${leg}: ${JSON.stringify(result.body)}`)
      const underLock = reads.filter((entry) => entry.locked)
      assert.deepEqual(underLock.map((entry) => entry.kind), lockedKinds, `${leg}: the whole comparison, stability round included, re-read under the lock`)
      assert.ok(underLock.every((entry) => entry.on === 'registry-transaction'), `${leg}: every read under the lock rode the registry's own transaction: ${JSON.stringify(underLock)}`)
      const unlocked = reads.filter((entry) => !entry.locked)
      assert.ok(unlocked.length > 0 && unlocked.every((entry) => entry.on === 'pool'), `${leg}: the unlocked pre-read stays on the pool`)
      assert.equal(h.db.rows.length, 1, `${leg}: one registry row`)
      assert.equal(db.heldLocks.size, 0, `${leg}: the lock is released`)
    } finally { h.restore() }
  }
})

test('R-19 read-plan runtime absent or unavailable never falls back to legacy source IO', async () => {
  for (const [store, status, code] of [
    [undefined, 501, 'READ_PLAN_RUNTIME_UNAVAILABLE'],
    [{ async getActiveForRuntime() { throw new Error('synthetic runtime unavailable') } }, 503, 'READ_PLAN_RUNTIME_UNAVAILABLE'],
  ]) {
    const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true', [ONLINE_READ_PLANS_ENABLED_ENV]: 'true' }, serviceExtras: { stockPreparationReadPlanStore: store } })
    try {
      registerActive(h)
      const res = await dryRun(h.routes, PULLER)
      assert.equal(res.statusCode, status, JSON.stringify(res.body))
      assert.equal(res.body.error.code, code)
      assert.deepEqual(h.records.queries, [], 'no target-row read through a legacy fallback')
      assert.deepEqual(h.records.writes, [], 'no write')
    } finally { h.restore() }
  }
})

test('R-19b online read plans switched OFF: the dry-run never touches the read-plan store (a missing or failing one cannot refuse it)', async () => {
  for (const store of [undefined, { async getActiveForRuntime() { throw new Error('synthetic runtime unavailable') } }]) {
    const calls = []
    const watched = store && { async getActiveForRuntime(input) { calls.push(input); return store.getActiveForRuntime(input) } }
    const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' }, serviceExtras: { stockPreparationReadPlanStore: watched } })
    try {
      registerActive(h)
      const res = await dryRun(h.routes, PULLER)
      assert.notEqual(res.body && res.body.error && res.body.error.code, 'READ_PLAN_RUNTIME_UNAVAILABLE', JSON.stringify(res.body))
      assert.deepEqual(calls, [], 'no activation pointer is read while the switch is off')
    } finally { h.restore() }
  }
})

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
    // PR B: the pilot lane gate reads the registry's pilot marker on every large route REGARDLESS of the
    // switch (step-4 design D3 / B-B3: switching the switch off must not bypass the refusal) — read-only
    // `selectOne` consults, never a write. Apart from them the registry was never consulted before the flip.
    assert.deepEqual(h.db.calls.filter((call) => call !== 'selectOne'), [], 'the registry was never consulted before the flip (pilot marker reads aside)')
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
      // PR B: the pilot marker is read on every large route regardless of the switch (read-only selectOne
      // consults; D3 / B-B3); nothing else of the registry is consulted while the switch is off.
      assert.deepEqual(h.db.calls.filter((call) => call !== 'selectOne'), [], 'the registry is never consulted while the switch is off (pilot marker reads aside)')
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
      // G1 field defect (R67): the contract option set landed on the decision column (counts only).
      options: { synced: 1, skipped: 0 },
      // B (awaiting owner): every plm_system column of the new sheet marked read-only for people (counts only).
      plmColumnLock: { marked: PLM_SYSTEM_IDS.length, alreadyMarked: 0, missing: 0 },
      // S3 fix round 1 (R6): this substrate is an OLDER host (no stamp declaration), so the create's
      // best-effort overview leg refuses before any IO and says so with its closed code — the create stands.
      overview: { ensured: false, created: false, code: 'STOCK_PREPARATION_PROJECT_OVERVIEW_HOST_UNSUPPORTED' },
    })
    assert.equal(h.provisioning.calls.filter((c) => c[0] === 'ensureObject').length, 1, 'ONE sheet provisioned')
    // G1 field defect (R67): ONE option patch, the decision column of THIS sheet — then (B, awaiting owner) ONE lock
    // patch per plm_system column of THIS sheet, in template order, and nothing else.
    assert.deepEqual(h.provisioning.calls.filter((c) => c[0] === 'patchObjectFieldProperty'), [
      ['patchObjectFieldProperty', objectId, 'lastPlmRefreshDecision'],
      ...PLM_SYSTEM_IDS.map((id) => ['patchObjectFieldProperty', objectId, id]),
    ], 'the option patch, then the PLM column locks — all on THIS sheet')
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
    assert.deepEqual(h.auditAppends[0].detail, {
      fillViewCreated: true,
      todoViewCreated: true,
      ownBaseSource: 'derived',
      plmLockMarkedFieldCount: PLM_SYSTEM_IDS.length,
      plmLockAlreadyMarkedFieldCount: 0,
      plmLockMissingFieldCount: 0,
    })
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

// ── R6 (batch-refresh phase 0 step 1): the large lane under the project write lock ────────────────────
//
// Approval bumps the plan generation and binds the job; the chunk route takes the SAME project write lease
// the small lane takes (busy -> 409 before any job write), refuses a job whose binding a newer preview
// superseded (job untouched), and fails closed 501 with no lock service.
test('R6 large lane: approval bumps + binds; the chunk route takes the project lease, refuses a superseded job untouched, and 501s without the lock', async () => {
  const kit = require(path.join(__dirname, 'support', 'stock-preparation-project-write-lock-kit.cjs'))
  const { PROJECT_WRITE_ERROR_CODES, PROJECT_WRITE_LOCK_TABLE, sheetWriteScopeKey } = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
  const env = kit.createInMemoryProjectWriteLock({ timers: 'real' })
  const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' }, serviceExtras: { stockPreparationProjectWriteLock: env.lock } })
  try {
    const { sheetId, objectId } = registerActive(h)
    const scope = sheetWriteScopeKey(sheetId)
    const jobId = 'job-swl-r6'
    await seedPlannedExpansionJob(h, { jobId, target: { sheetId, objectId, fieldIdMap: {} } })
    assert.equal((await plan(h.routes, jobId)).statusCode, 200)
    const storedJob = async (applyJobId) => h.context.storage.get(largeBomJobs.__internals.checkpointApplyJobKey({ ...JOB_SCOPE, actionId: PLM_STOCK_PREPARATION_ACTION_ID, applyJobId }))
    const approved = await applyStart(h.routes, jobId)
    assert.equal(approved.statusCode, 202, JSON.stringify(approved.body))
    const applyJobId = approved.body.data.jobId
    const row = () => env.db.rows(PROJECT_WRITE_LOCK_TABLE).find((r) => r.scope_key === scope)
    assert.equal(row().generation, 1, 'the approval bumped the generation')
    const bound = await storedJob(applyJobId)
    assert.equal(bound.writeScope, scope, 'the job is bound to its project sheet (R-52)')
    assert.equal(bound.writeGenerationToken, row().generation_token)
    assert.equal(JSON.stringify(approved.body).includes(bound.writeGenerationToken), false, 'the binding is never answered')

    // Busy: another run holds the project -> 409 before any job write.
    const holder = await env.lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-r6-small' })
    const busy = await applyRun(h.routes, jobId, applyJobId)
    assert.equal(busy.statusCode, 409, JSON.stringify(busy.body))
    assert.equal(busy.body.error.code, PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
    assert.deepEqual(await storedJob(applyJobId), bound, 'job untouched by a busy refusal')
    await env.lock.createGuard(holder).release()

    // Superseded: a newer preview of the project -> 409 PLAN_SUPERSEDED, job untouched.
    await env.lock.bumpGeneration(scope, { reason: 'small_preview' })
    const superseded = await applyRun(h.routes, jobId, applyJobId)
    assert.equal(superseded.statusCode, 409, JSON.stringify(superseded.body))
    assert.equal(superseded.body.error.code, PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED)
    assert.equal(superseded.body.error.details.reason, 'newer_plan')
    assert.deepEqual(await storedJob(applyJobId), bound, 'job untouched by a superseded refusal')
    assert.equal(row().lease_id, null, 'the lease was released')

    // P1-b: re-approving the SAME expansion after the newer preview is refused `expansion_stale` (nothing
    // bumped, no job); re-planning it too. A FRESH expansion of the project plans, approves and runs.
    const generationBefore = row().generation
    const stale = await applyStart(h.routes, jobId)
    assert.equal(stale.statusCode, 409, JSON.stringify(stale.body))
    assert.equal(stale.body.error.code, PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED)
    assert.equal(stale.body.error.details.reason, 'expansion_stale')
    assert.equal(row().generation, generationBefore, 'a stale approval bumps nothing')
    const stalePlan = await plan(h.routes, jobId)
    assert.equal(stalePlan.statusCode, 409, JSON.stringify(stalePlan.body))
    assert.equal(stalePlan.body.error.details.reason, 'expansion_stale')
    const freshJobId = 'job-swl-r6-fresh'
    await seedPlannedExpansionJob(h, { jobId: freshJobId, target: { sheetId, objectId, fieldIdMap: {} } })
    assert.equal((await plan(h.routes, freshJobId)).statusCode, 200)
    const again = await applyStart(h.routes, freshJobId)
    assert.equal(again.statusCode, 202, JSON.stringify(again.body))
    const ran = await applyRun(h.routes, freshJobId, again.body.data.jobId)
    assert.equal(ran.statusCode, 200, JSON.stringify(ran.body))
    assert.notEqual((await storedJob(again.body.data.jobId)).status, 'queued')
  } finally { h.restore() }

  const bare = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' }, serviceExtras: { stockPreparationProjectWriteLock: null } })
  try {
    const { sheetId, objectId } = registerActive(bare)
    const jobId = 'job-swl-r6-bare'
    await seedPlannedExpansionJob(bare, { jobId, target: { sheetId, objectId, fieldIdMap: {} } })
    assert.equal((await plan(bare.routes, jobId)).statusCode, 200)
    const approved = await applyStart(bare.routes, jobId)
    assert.equal(approved.statusCode, 202, 'approval without the lock service creates an UNBOUND job')
    const refused = await applyRun(bare.routes, jobId, approved.body.data.jobId)
    assert.equal(refused.statusCode, 501, JSON.stringify(refused.body))
    assert.equal(refused.body.error.code, PROJECT_WRITE_ERROR_CODES.UNAVAILABLE)
    const stored = await bare.context.storage.get(largeBomJobs.__internals.checkpointApplyJobKey({ ...JOB_SCOPE, actionId: PLM_STOCK_PREPARATION_ACTION_ID, applyJobId: approved.body.data.jobId }))
    assert.equal(stored.status, 'queued', 'nothing ran')
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'writeScope'), false)
  } finally { bare.restore() }
})

test('R6g (batch-refresh step 4 PR-3a: RW-G2 / RW-G6r / CG chunk legs) the chunk route consults INSIDE its lease: an unwired governance service is 501 governance_service; a project governed by a hold on its sheet 409 LARGE_LANE_REFUSED hold; a project governed by rows on ANOTHER sheet 409 RETARGETED sheet — each before the job turns running (the job byte-identical), no record write; a not-governed project runs', async () => {
  const kit = require(path.join(__dirname, 'support', 'stock-preparation-project-write-lock-kit.cjs'))
  const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
  const storedJob = (h, applyJobId) => h.context.storage.get(largeBomJobs.__internals.checkpointApplyJobKey({ ...JOB_SCOPE, actionId: PLM_STOCK_PREPARATION_ACTION_ID, applyJobId }))
  const hold = () => {
    const value = { kind: 'content_change', confirmable: false, notConfirmableReason: 'needs_step5', subject: { keyDigest: 'd'.repeat(64) }, detail: { recordId: null, recordVersion: null, key: 'k_r6g', reason: 'plm_system_refresh', fields: {}, inContinuation: null, humanColumnsPresent: {} } }
    value.fingerprint = pairing.holdFingerprint(value)
    return value
  }
  const legs = [
    { name: 'unwired', serviceExtras: { stockPreparationRefreshGovernance: null }, seed: async () => {}, status: 501, code: 'STOCK_PREP_REFRESH_STORE_UNAVAILABLE', reason: 'governance_service' },
    { name: 'governed', serviceExtras: {}, seed: async (h, sheetId) => h.refresh.seedHolds({ tenantId: TENANT, sheetId, projectNo: PROJECT }, [hold()]), status: 409, code: 'STOCK_PREP_REFRESH_LARGE_LANE_REFUSED', reason: 'hold' },
    { name: 'retargeted', serviceExtras: {}, seed: async (h) => h.refresh.seedHolds({ tenantId: TENANT, sheetId: 'sheet_r6g_previous', projectNo: PROJECT }, [hold()]), status: 409, code: 'STOCK_PREP_REFRESH_TARGET_RETARGETED', reason: 'sheet' },
    { name: 'not governed', serviceExtras: {}, seed: async () => {}, status: 200 },
  ]
  const lockLib = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
  for (const leg of legs) {
    const env = kit.createInMemoryProjectWriteLock({ timers: 'real' })
    const records = makeRecordsApi()
    const h = mount({ env: { [PROJECT_SHEETS_ENABLED_ENV]: 'true' }, records, serviceExtras: { stockPreparationProjectWriteLock: env.lock, ...leg.serviceExtras } })
    try {
      const { sheetId, objectId } = registerActive(h)
      const jobId = `job-r6g-${leg.name.replace(/\s+/g, '-')}`
      await seedPlannedExpansionJob(h, { jobId, target: { sheetId, objectId, fieldIdMap: {} } })
      // Batch-refresh step 4 PR-3b: the plan and approval ROUTES consult governance too, so the job is approved while
      // the project is NOT governed and becomes governed only AFTERWARDS (a job approved before its project became
      // governed — exactly what the chunk's in-lease gate exists for). An unwired deployment cannot plan through
      // the route at all any more (501 at the plan); its job is planned and approved through the lib, with the
      // route-shaped not-governed verdict, so the chunk's own unwired refusal is still what this leg proves.
      let applyJobId
      if (leg.name === 'unwired') {
        const unwiredPlan = await plan(h.routes, jobId)
        assert.equal(unwiredPlan.statusCode, 501, `unwired plan route: ${JSON.stringify(unwiredPlan.body)}`)
        assert.equal(unwiredPlan.body.error.details.reason, 'governance_service')
        const scope = lockLib.sheetWriteScopeKey(sheetId)
        await largeBomJobs.planLargeBomBackgroundExpansionJob({
          storage: h.context.storage, ...JOB_SCOPE, actionId: PLM_STOCK_PREPARATION_ACTION_ID, jobId, existingRows: [],
          governanceVerdict: { consulted: true, verdict: 'not_governed', generationToken: (await env.lock.readGeneration(scope)).generationToken },
          writeGenerationReader: (observed) => env.lock.readGeneration(observed),
        })
        const libApproved = await largeBomJobs.createLargeBomCheckpointApplyJob({
          storage: h.context.storage, ...JOB_SCOPE, actionId: PLM_STOCK_PREPARATION_ACTION_ID, jobId, principal: PLATFORM_ADMIN.id, permission: 'write', acceptManualConfirmHold: true,
          writeGenerationBinder: async (expect) => lockLib.writeBindingFromGeneration(await env.lock.bumpGeneration(scope, { reason: 'large_approval', tenantId: TENANT, expect })),
        })
        applyJobId = libApproved.jobId
      } else {
        assert.equal((await plan(h.routes, jobId)).statusCode, 200, leg.name)
        const approved = await applyStart(h.routes, jobId)
        assert.equal(approved.statusCode, 202, `${leg.name}: ${JSON.stringify(approved.body)}`)
        applyJobId = approved.body.data.jobId
      }
      await leg.seed(h, sheetId)
      const before = await storedJob(h, applyJobId)
      const ran = await applyRun(h.routes, jobId, applyJobId)
      assert.equal(ran.statusCode, leg.status, `${leg.name}: ${JSON.stringify(ran.body)}`)
      if (leg.status === 200) {
        assert.notEqual((await storedJob(h, applyJobId)).status, 'queued', `${leg.name}: the chunk ran`)
        continue
      }
      assert.equal(ran.body.error.code, leg.code, leg.name)
      assert.equal(ran.body.error.details.reason, leg.reason, leg.name)
      const after = await storedJob(h, applyJobId)
      assert.equal(after.status, 'queued', `${leg.name}: never turned running`)
      assert.deepEqual(after, before, `${leg.name}: the job is byte-identical`)
      assert.equal(records.writes.length, 0, `${leg.name}: no record write`)
    } finally { h.restore() }
  }
})

// S3 follow-ups 2 (item 5): the fail-closed runner (support/fail-closed-suite-runner.cjs) — the same per-test loop
// and output lines, plus the exit sentinel and the per-test timeout: a hung test can never end this suite with exit 0.
require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-project-target-routes.test.cjs', tests, { passLine: '✓ stock-preparation-project-target-routes' })
