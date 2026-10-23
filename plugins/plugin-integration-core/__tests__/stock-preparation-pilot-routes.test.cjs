'use strict'

// 备料分批拉取第一期 step 3 PR B — THE PILOT ROUTES AND THE LANE REFUSALS, over the real route stack
// (support/stock-preparation-project-sheet-harness.cjs: the REAL registry store on a memory db, the REAL
// in-memory write lock, a host whose provisioning records every call and — opt-in here — offers the per-field
// read and the #6507 grid-export closure port pair). Plan §5.1 / §7 G5, G7 / §9.4 L01–L05 / §9.5 U05.
//
//   P-01 SWITCH OFF: GET / POST pilot answer 404 DISABLED with ZERO IO for the admitted tiers; below ADMIN the gate
//        refuses first (403 / 401), zero IO
//   P-02 THE TIERS: floor, read-only, puller, orphan pull/operate and anonymous are refused at the gate with zero IO;
//        stock-prep:admin and the platform admin pass (GET 200)
//   P-03 THE TYPED CONFIRMATION + the query allowlist: mismatch / missing / folded / non-string → 400 CONFIRM_MISMATCH,
//        an extra body key / a bad path number / an unknown query key → 400 REQUEST_INVALID, all before any IO
//   P-04 GET: absent → 200 `absent`; active (plain mount) → 200 with the readiness LISTING the failing ids and
//        `may.enable: false`; archived → 200 with readiness null; the answer is values-free; GET writes nothing
//   P-05 POST NOT READY (plain mount): 409 STOCK_PREP_PILOT_NOT_READY listing the failing ids — nothing bumped, no
//        lease, no stamp, no mark, no audit row; a later migration's missing store is one of the ids
//   P-06 POST READY (prepared mount): 200 — the generation BUMPED (reason pilot_enable), the host stamp requested
//        INSIDE the lease with exactly (staging project, sheet, objectId, actor), the registry row marked (at / by /
//        version 1) AFTER the stamp, the lease released, ONE audit row `project_pilot_enable` (values-free detail)
//   P-07 RE-POST: the stamp is requested again (alreadyClosed), the mark answers alreadyEnabled, NO second audit row;
//        a stamp the host lost is repaired by the re-POST
//   P-08 THE TENANT WALL: another tenant's project is ABSENT (409) here; a tenantless platform admin is refused by
//        the operator scope; the readiness probes never run for them
//   P-09 ARCHIVED: GET answers the state with readiness null; POST is 409 ARCHIVED (the overlay's write lookup),
//        nothing done
//   P-10 A WRITER THAT ARRIVES BETWEEN READINESS AND THE BUMP: the bump is refused 409 WRITE_LOCKED and nothing is
//        stamped, marked or audited; a live lease seen by readiness fails `write_lock_free`
//   P-11 THE AUDIT VOCABULARY PROBE: a database without migration 101 is 503 before readiness, the lock or the host
//   L-01 THE FIVE LARGE ROUTES refuse a PILOT project 409 STOCK_PREP_PILOT_LARGE_LANE_REFUSED naming the lane — no
//        job created, no source read, no host write; L05: the same five requests on a NON-pilot project are served
//        exactly as before (202 / 200)
//   L-02 A JOB APPROVED BEFORE THE ENABLEMENT: the chunk is refused with the PILOT code (not PLAN_SUPERSEDED, although
//        the enable bumped the generation) and the job stays `queued` — zero record writes; and the IN-LEASE check
//        alone (the route gate passing, the marker landing between it and the lease) refuses before `running`
//   L-03 OVER THE SMALL-LANE CAP: a pilot project's dry run answers 409 SMALL_LANE_LIMIT_EXCEEDED — no token, the pull
//        stamped `refused`; the same pull on a non-pilot project answers 200 `large_bom_bounded` byte for byte
//   L-04 SPLIT / RE-ENTRY: the pilot project number through a job that targets ANOTHER sheet is refused by project
//        identity; another project number through a job that targets the PILOT sheet is refused by sheet identity —
//        with the switch OFF too (the marker is read regardless of the switch)
//   L-05 SOURCE ORDER: in each of the five handlers the gate call follows the staleness check and precedes every IO
//        and the lease; the chunk hands the lib `largeLanePilotCheck`; the dry run hands the lib `pilotLaneGuard`
//   L-06 AN UNREADABLE MARKER: every large route and the over-cap dry run answer 503 STATE_UNREADABLE, never proceed
//
// Synthetic values only.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const projectSheet = require('./support/stock-preparation-project-sheet-harness.cjs')
const kit = require('./support/stock-preparation-project-write-lock-kit.cjs')
const {
  STOCK_PREP_ADMIN,
  STOCK_PREP_OPERATE,
  STOCK_PREP_PULL,
  STOCK_PREP_READ,
} = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { PROJECT_SHEETS_ENABLED_ENV, PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS } = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE, normalizeStockPreparationTemplate } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { templateContractOptionFields } = require(path.join(LIB, 'stock-preparation-option-sync.cjs'))
const { PILOT_ERROR_CODES } = require(path.join(LIB, 'stock-preparation-pilot-gate.cjs'))
const { PILOT_READINESS_CHECK_IDS, PILOT_READINESS_VERSION, SPEC_READ_PLAN_SLOT_NOT_APPLICABLE } = require(path.join(LIB, 'stock-preparation-pilot-readiness.cjs'))
const continuationSupport = require(path.join(LIB, 'stock-preparation-continuation-support.cjs'))
const largeBomJobs = require(path.join(LIB, 'stock-preparation-large-bom-jobs.cjs'))
const swlLockLib = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))

const HTTP_ROUTES_SOURCE = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8')

const TENANT = 'tenant-syn-pb'
const OTHER_TENANT = 'tenant-syn-pb-foreign'
const PROJECT = 'PRJ-PB-01'
const OTHER_PROJECT = 'PRJ-PB-02'
const ACTION_ID = PLM_STOCK_PREPARATION_ACTION_ID
const JOB_SCOPE = Object.freeze({ tenantId: TENANT, workspaceId: 'workspace-default' })

const PILOT_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/pilot'
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const JOBS_PATH = '/api/integration/table-actions/:actionId/large-bom/expansion-jobs'
const RUN_PATH = `${JOBS_PATH}/:jobId/run`
const PLAN_PATH = `${JOBS_PATH}/:jobId/plan`
const APPLY_START_PATH = `${JOBS_PATH}/:jobId/apply-jobs`
const APPLY_RUN_PATH = `${JOBS_PATH}/:jobId/apply-jobs/:applyJobId/run`

const FLOOR = Object.freeze({ id: 'u_pb_floor', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const READ_ONLY = Object.freeze({ id: 'u_pb_read', tenantId: TENANT, permissions: [STOCK_PREP_READ] })
const PULLER = Object.freeze({ id: 'u_pb_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const ORPHAN_PULL = Object.freeze({ id: 'u_pb_orphan_pull', tenantId: TENANT, permissions: [STOCK_PREP_PULL] })
const ORPHAN_OPERATE = Object.freeze({ id: 'u_pb_orphan_op', tenantId: TENANT, permissions: [STOCK_PREP_OPERATE] })
const WORKBENCH_ADMIN = Object.freeze({ id: 'u_pb_wb_admin', tenantId: TENANT, permissions: [STOCK_PREP_ADMIN] })
const PLATFORM_ADMIN = Object.freeze({ id: 'u_pb_admin', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] })
const TENANTLESS_ADMIN = Object.freeze({ id: 'u_pb_tenantless', roles: ['admin'], permissions: ['integration:admin'] })

const tests = []
const test = (name, fn) => tests.push([name, fn])

const confirm = (projectNo = PROJECT) => ({ confirmProjectNo: projectNo })
/** The error details as plain JSON (the route sanitizer answers a null-prototype object). */
const details = (res) => JSON.parse(JSON.stringify(res.body.error.details))
const getPilot = (h, user, projectNo = PROJECT, query = {}) => projectSheet.call(h.routes, 'GET', PILOT_PATH, { user, params: { projectNo }, query })
const enablePilot = (h, user, projectNo = PROJECT, body = confirm(projectNo)) => projectSheet.call(h.routes, 'POST', PILOT_PATH, { user, params: { projectNo }, body })
const dryRun = (h, user = PLATFORM_ADMIN, projectNo = PROJECT) => projectSheet.call(h.routes, 'POST', DRY_RUN_PATH, { user, params: { actionId: ACTION_ID }, body: { parameters: { projectNo } }, query: { tenantId: TENANT } })
const jobParams = (jobId, applyJobId) => ({ actionId: ACTION_ID, jobId, ...(applyJobId ? { applyJobId } : {}) })
const expansionStart = (h, projectNo = PROJECT, user = PLATFORM_ADMIN) => projectSheet.call(h.routes, 'POST', JOBS_PATH, { user, params: { actionId: ACTION_ID }, body: { parameters: { projectNo } }, query: { tenantId: TENANT } })
const expansionRun = (h, jobId, user = PLATFORM_ADMIN) => projectSheet.call(h.routes, 'POST', RUN_PATH, { user, params: jobParams(jobId), body: {}, query: { tenantId: TENANT } })
const plan = (h, jobId, user = PLATFORM_ADMIN) => projectSheet.call(h.routes, 'POST', PLAN_PATH, { user, params: jobParams(jobId), body: {}, query: { tenantId: TENANT } })
const applyStart = (h, jobId, user = PLATFORM_ADMIN) => projectSheet.call(h.routes, 'POST', APPLY_START_PATH, { user, params: jobParams(jobId), body: { confirm: { acceptManualConfirmHold: true } }, query: { tenantId: TENANT } })
const applyRun = (h, jobId, applyJobId, user = PLATFORM_ADMIN) => projectSheet.call(h.routes, 'POST', APPLY_RUN_PATH, { user, params: jobParams(jobId, applyJobId), body: {}, query: { tenantId: TENANT } })

const TEMPLATE = normalizeStockPreparationTemplate(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)

/** The registries the generic-writer readiness check asks: the harness's inert ones answer the list reads with nothing. */
function answeringRegistries(sourceAdapter) {
  const base = projectSheet.baseServices(sourceAdapter)
  return {
    externalSystemRegistry: { ...base.externalSystemRegistry, async listExternalSystems() { return [] } },
    pipelineRegistry: { ...base.pipelineRegistry, async listPipelines() { return [] } },
  }
}

function mount(options = {}) {
  return projectSheet.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, switchOn: true, ...options })
}

/**
 * A mount on which EVERY readiness check can pass: a host with field reads and the closure port, a server config
 * declaring the 规格 slot not applicable, registries that answer, the build marker flipped IN MEMORY for the mount's
 * lifetime (restored by `restore()`), and a registered ACTIVE project whose sheet carries the PLM lock and the
 * contract option lists.
 */
function mountReady(options = {}) {
  const originalMarker = continuationSupport.CONTINUATION_SUPPORT_VERSION
  continuationSupport.CONTINUATION_SUPPORT_VERSION = 1
  const h = mount({
    fieldReads: true,
    gridExportClosure: true,
    configExtras: { stockPreparationPilot: { specReadPlanSlot: SPEC_READ_PLAN_SLOT_NOT_APPLICABLE } },
    ...options,
  })
  const originalRestore = h.restore
  h.restore = () => { continuationSupport.CONTINUATION_SUPPORT_VERSION = originalMarker; originalRestore() }
  const registries = answeringRegistries(h.source.adapter)
  // The routes captured the service objects at mount: patch the captured objects in place.
  Object.assign(h.services.externalSystemRegistry, registries.externalSystemRegistry)
  Object.assign(h.services.pipelineRegistry, registries.pipelineRegistry)
  const seeded = h.seedRegistryRow(PROJECT)
  prepareSheetForPilot(h, seeded.objectId)
  return { ...h, ...seeded }
}

function prepareSheetForPilot(h, objectId) {
  const object = h.provisioning.objects.get(`${h.staging}/${objectId}`)
  assert.ok(object, 'the seeded sheet exists on the host')
  for (const fieldId of PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS) object.fields.get(fieldId).property.humanWriteLock = 'plm_system'
  for (const field of templateContractOptionFields(TEMPLATE)) object.fields.get(field.id).property.options = [{ value: 'syn_option' }]
}

/** Mark the registry row pilot DIRECTLY (what the enable route does, minus the stamp / audit) — the lane tests' fixture. */
function markPilotDirectly(h, projectNo = PROJECT, { tenant = TENANT } = {}) {
  const row = h.registryRows().find((entry) => entry.tenant_id === tenant && entry.project_no === projectNo)
  assert.ok(row, 'the registry row exists')
  row.pilot_enabled_at = new Date('2026-10-23T00:00:00Z')
  row.pilot_enabled_by = 'seed'
  row.pilot_readiness_version = 1
  return row
}

/** A planned, authoritative expansion job stored the way the routes store it (copied from the S4 suites). */
async function seedPlannedExpansionJob(h, { jobId, target, projectNo = PROJECT, status = 'completed' }) {
  const at = '2026-10-23T00:00:00.000Z'
  const seedLock = h.projectWriteLock
  const writeObservation = seedLock && target && typeof target.sheetId === 'string'
    ? swlLockLib.writeObservationFromGeneration(await seedLock.observeGeneration(swlLockLib.sheetWriteScopeKey(target.sheetId)))
    : null
  const job = {
    jobId, ...JOB_SCOPE, actionId: ACTION_ID,
    status, authoritative: status === 'completed', projectNoPresent: true,
    parameters: { projectNo },
    principal: PLATFORM_ADMIN.id,
    actor: PLATFORM_ADMIN.id,
    actionSnapshot: {
      actionId: ACTION_ID,
      source: { externalSystemId: 'plm_sql_source_synthetic', kind: 'data-source:sql-readonly' },
      target,
    },
    sourceKind: 'data-source:sql-readonly',
    artifactRevision: 'artifact-pb-1',
    artifact: { revision: 'artifact-pb-1', status: 'expanded', rows: [], summary: {}, sealedAt: at },
    planRevision: 'plan-pb-1',
    planArtifact: { revision: 'plan-pb-1', artifactRevision: 'artifact-pb-1', plan: { revision: 'plan-pb-1', decisions: [], plannedAt: at }, existingRowCount: 0, plannedAt: at },
    progress: { rowsExpanded: 0, readCount: 0, frontierRemaining: 0, completedChunks: 1 },
    budgets: {},
    evidence: { sourceKind: 'data-source:sql-readonly', readObjects: [], errorTypes: [], readDiagnosticShapePresent: false },
    createdAt: at, updatedAt: at,
    ...(writeObservation ? { writeObservation, planWriteObservation: writeObservation } : {}),
  }
  await h.context.storage.set(largeBomJobs.__internals.backgroundJobKey({ ...JOB_SCOPE, actionId: ACTION_ID, jobId }), job)
  return job
}

const checkpointKey = (applyJobId) => largeBomJobs.__internals.checkpointApplyJobKey({ ...JOB_SCOPE, actionId: ACTION_ID, applyJobId })

function registryReadCount(h) {
  return h.db.calls.filter((call) => call === 'selectOne:integration_stock_prep_project_target').length
}

// ── the pilot routes ────────────────────────────────────────────────────────────────────────────────

test('P-01 switch OFF: GET / POST pilot are 404 DISABLED with zero IO for the admitted tiers; below ADMIN the gate refuses first', async () => {
  const h = mount({ switchOn: false })
  try {
    h.seedRegistryRow(PROJECT)
    for (const user of [WORKBENCH_ADMIN, PLATFORM_ADMIN]) {
      for (const [label, run] of [['get', getPilot], ['enable', enablePilot]]) {
        const res = await run(h, user)
        assert.equal(res.statusCode, 404, `${label} as ${user.id}: ${JSON.stringify(res.body)}`)
        assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED')
      }
    }
    for (const user of [undefined, FLOOR, READ_ONLY, PULLER, ORPHAN_PULL, ORPHAN_OPERATE]) {
      for (const run of [getPilot, enablePilot]) {
        const res = await run(h, user)
        assert.equal(res.statusCode, user ? 403 : 401, `${user ? user.id : 'anonymous'}: ${JSON.stringify(res.body)}`)
      }
    }
    assert.deepEqual(h.db.calls, [], 'no registry statement')
    assert.deepEqual(h.provisioning.calls, [], 'no host call')
    assert.deepEqual(h.auditAppends, [], 'no audit row')
    assert.deepEqual(h.tenantDirectoryCalls, [], 'not even the scope lookup')
    assert.equal(h.registryRows()[0].pilot_enabled_at, undefined, 'the row is untouched')
  } finally { h.restore() }
})

test('P-02 the tiers: floor / read-only / puller / orphans / anonymous refused at the gate with zero IO; stock-prep:admin and the platform admin pass', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    for (const user of [undefined, FLOOR, READ_ONLY, PULLER, ORPHAN_PULL, ORPHAN_OPERATE]) {
      for (const run of [getPilot, enablePilot]) {
        const res = await run(h, user)
        assert.equal(res.statusCode, user ? 403 : 401, `${user ? user.id : 'anonymous'}: ${JSON.stringify(res.body)}`)
        assert.equal(res.body.error.code, user ? 'FORBIDDEN' : 'UNAUTHENTICATED')
      }
    }
    assert.deepEqual(h.db.calls, [], 'a refused caller costs no registry statement')
    assert.deepEqual(h.provisioning.calls, [], 'a refused caller costs no host call')
    assert.deepEqual(h.auditAppends, [])
    for (const user of [WORKBENCH_ADMIN, PLATFORM_ADMIN]) {
      const res = await getPilot(h, user)
      assert.equal(res.statusCode, 200, `${user.id}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.data.status, 'active')
    }
  } finally { h.restore() }
})

test('P-03 the typed confirmation and the query allowlist: refused 400 before any IO, values-free', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    for (const body of [{}, { confirmProjectNo: OTHER_PROJECT }, { confirmProjectNo: PROJECT.toLowerCase() }, { confirmProjectNo: PROJECT.slice(0, -1) }, { confirmProjectNo: 7 }, { confirmProjectNo: '' }, { confirmProjectNo: null }]) {
      const res = await enablePilot(h, WORKBENCH_ADMIN, PROJECT, body)
      assert.equal(res.statusCode, 400, JSON.stringify(body))
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH')
      assert.deepEqual({ ...res.body.error.details }, { field: 'confirmProjectNo' })
      const text = JSON.stringify(res.body)
      assert.ok(!text.includes(PROJECT) && !text.includes(OTHER_PROJECT) && !text.includes(PROJECT.toLowerCase()), 'the refusal echoes neither number')
    }
    const extra = await enablePilot(h, WORKBENCH_ADMIN, PROJECT, { confirmProjectNo: PROJECT, tenantId: TENANT })
    assert.equal(extra.statusCode, 400)
    assert.equal(extra.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_REQUEST_INVALID')
    for (const bad of ['a b', '-leading', 'x'.repeat(81)]) {
      assert.equal((await enablePilot(h, WORKBENCH_ADMIN, bad, { confirmProjectNo: bad })).statusCode, 400, `path ${JSON.stringify(bad)}`)
      assert.equal((await getPilot(h, WORKBENCH_ADMIN, bad)).statusCode, 400, `get path ${JSON.stringify(bad)}`)
    }
    const unknownQuery = await getPilot(h, WORKBENCH_ADMIN, PROJECT, { projectNo: PROJECT })
    assert.equal(unknownQuery.statusCode, 400)
    assert.equal(unknownQuery.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_REQUEST_INVALID')
    assert.deepEqual(h.db.calls, [], 'no registry statement for a refused request')
    assert.deepEqual(h.provisioning.calls, [])
    assert.deepEqual(h.auditAppends, [])
    assert.equal(h.registryRows()[0].pilot_enabled_at, undefined)
    // The same trim the path value gets: surrounding whitespace is not a mismatch (it reaches readiness, which refuses).
    const trimmed = await enablePilot(h, WORKBENCH_ADMIN, PROJECT, { confirmProjectNo: ` ${PROJECT} ` })
    assert.equal(trimmed.statusCode, 409, JSON.stringify(trimmed.body))
    assert.equal(trimmed.body.error.code, PILOT_ERROR_CODES.NOT_READY)
  } finally { h.restore() }
})

test('P-04 GET: absent → 200 absent; active (plain mount) → the readiness lists the failing ids and may.enable false; values-free; nothing written', async () => {
  const h = mount()
  try {
    const absent = await getPilot(h, WORKBENCH_ADMIN)
    assert.equal(absent.statusCode, 200, JSON.stringify(absent.body))
    assert.deepEqual(absent.body.data, { projectNo: PROJECT, status: 'absent', pilot: null, readiness: null, may: { enable: false } })
    const { sheetId, objectId } = h.seedRegistryRow(PROJECT)
    const active = await getPilot(h, WORKBENCH_ADMIN)
    assert.equal(active.statusCode, 200, JSON.stringify(active.body))
    const data = active.body.data
    assert.equal(data.status, 'active')
    assert.deepEqual(data.pilot, { enabled: false, enabledAt: null, enabledBy: null, readinessVersion: null })
    assert.deepEqual(data.may, { enable: false })
    assert.equal(data.readiness.version, PILOT_READINESS_VERSION)
    assert.equal(data.readiness.ready, false)
    assert.deepEqual(data.readiness.checks.map((check) => check.id), [...PILOT_READINESS_CHECK_IDS])
    // On a plain mount these cannot pass: no field read port (PLM lock / option lists unprovable), no closure port,
    // no 规格 declaration, inert registries, and the shipped build marker.
    assert.deepEqual(data.readiness.failing, ['plm_column_lock', 'contract_option_sets', 'export_closure_port', 'spec_read_plan_slot', 'no_generic_writer_names_sheet', 'continuation_support_version'])
    const text = JSON.stringify(active.body)
    assert.ok(!text.includes(sheetId) && !text.includes(objectId) && !text.includes(TENANT), 'values-free: no sheet id, objectId or tenant in the answer')
    assert.ok(!h.provisioning.calls.some(([verb]) => /^(ensure|patch|grant|close)/.test(verb)), 'GET writes nothing on the host')
    assert.ok(!h.db.calls.some((call) => /^(insertOne|updateRow|transaction)/.test(call)), 'GET writes nothing in the registry')
    assert.deepEqual(h.auditAppends, [])
    assert.equal(h.registryRows()[0].pilot_enabled_at, undefined)
  } finally { h.restore() }
})

test('P-05 POST not ready: 409 NOT_READY listing the failing ids — nothing bumped, no lease, no stamp, no mark, no audit row', async () => {
  const h = mount()
  try {
    const { sheetId } = h.seedRegistryRow(PROJECT)
    const scope = swlLockLib.sheetWriteScopeKey(sheetId)
    const before = await h.projectWriteLock.readState(scope)
    const res = await enablePilot(h, WORKBENCH_ADMIN)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, PILOT_ERROR_CODES.NOT_READY)
    assert.deepEqual(details(res), { version: PILOT_READINESS_VERSION, failing: ['plm_column_lock', 'contract_option_sets', 'export_closure_port', 'spec_read_plan_slot', 'no_generic_writer_names_sheet', 'continuation_support_version'], partial: false })
    assert.deepEqual(await h.projectWriteLock.readState(scope), before, 'the generation did not move and no lease was taken')
    assert.equal(h.provisioning.gridExportClosureCalls.length, 0, 'no stamp requested')
    assert.ok(!h.db.calls.some((call) => /^(updateRow|transaction)/.test(call)), 'no registry write')
    assert.deepEqual(h.auditAppends, [])
    assert.equal(h.registryRows()[0].pilot_enabled_at, undefined)
    // U05 (缺任一项则不能启用): a prepared mount whose step-4 store is unreadable refuses by THAT id alone.
    const ready = mountReady()
    try {
      const originalProbe = ready.projectTargetStore.probeTableReadable
      ready.projectTargetStore.probeTableReadable = async (table) => (table === 'integration_stock_prep_continuation' ? { readable: false, reason: 'undefined_table' } : originalProbe(table))
      const refused = await enablePilot(ready, WORKBENCH_ADMIN)
      assert.equal(refused.statusCode, 409, JSON.stringify(refused.body))
      assert.deepEqual(details(refused).failing, ['continuation_store_readable'])
      assert.equal(ready.provisioning.gridExportClosureCalls.length, 0)
      assert.deepEqual(ready.auditAppends, [])
      assert.equal(ready.registryRows()[0].pilot_enabled_at, undefined)
    } finally { ready.restore() }
  } finally { h.restore() }
})

test('P-06 POST ready: bump → lease → host stamp (exact ids) → registry mark → release → ONE audit row', async () => {
  const h = mountReady()
  try {
    const { sheetId, objectId } = h
    const scope = swlLockLib.sheetWriteScopeKey(sheetId)
    const order = []
    // Observe the lock at the moment the host stamp is requested: the lease must be held, the generation already bumped.
    const closeOriginal = h.provisioning.closeSheetGridExport
    let stateAtStamp = null
    h.provisioning.closeSheetGridExport = async (input) => { stateAtStamp = await h.projectWriteLock.readState(scope); order.push('stamp'); return closeOriginal(input) }
    const markOriginal = h.projectTargetStore.markPilotEnabled
    h.projectTargetStore.markPilotEnabled = async (input) => { order.push('mark'); return markOriginal(input) }
    const appendOriginal = h.services.stockPreparationAuditStore.append
    h.services.stockPreparationAuditStore.append = async (entry) => { order.push('audit'); return appendOriginal(entry) }
    const res = await enablePilot(h, WORKBENCH_ADMIN)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const data = res.body.data
    assert.equal(data.enabled, true)
    assert.equal(data.alreadyEnabled, false)
    assert.deepEqual(data.exportClosure, { closed: true, alreadyClosed: false })
    assert.equal(data.status, 'active')
    assert.deepEqual(data.readiness.failing, [])
    assert.equal(data.pilot.enabled, true)
    assert.equal(data.pilot.enabledBy, WORKBENCH_ADMIN.id)
    assert.equal(data.pilot.readinessVersion, PILOT_READINESS_VERSION)
    assert.equal(typeof data.pilot.enabledAt, 'string')
    // Order: the stamp inside the lease, after the bump; then the mark; then the audit row after release.
    assert.deepEqual(order, ['stamp', 'mark', 'audit'])
    assert.equal(stateAtStamp.leaseHeld, true, 'the stamp was requested while the lease was held')
    assert.equal(stateAtStamp.leasePurpose, 'pilot_enable')
    assert.equal(stateAtStamp.generation, 1, 'the bump preceded the stamp')
    assert.equal(stateAtStamp.generationReason, 'pilot_enable')
    const after = await h.projectWriteLock.readState(scope)
    assert.equal(after.leaseHeld, false, 'the lease was released')
    assert.equal(after.generation, 1)
    // The stamp carried exactly the registry's ids and the actor; the host column holds it.
    assert.deepEqual(h.provisioning.gridExportClosureCalls, [{ projectId: h.staging, sheetId, objectId, actorId: WORKBENCH_ADMIN.id }])
    assert.ok(h.provisioning.gridExportClosures.has(sheetId), 'the sheet is closed for grid export')
    // The registry row.
    const row = h.registryRows()[0]
    assert.ok(row.pilot_enabled_at instanceof Date)
    assert.equal(row.pilot_enabled_by, WORKBENCH_ADMIN.id)
    assert.equal(row.pilot_readiness_version, PILOT_READINESS_VERSION)
    assert.equal(row.status, 'active')
    // ONE audit row, values-free.
    assert.deepEqual(h.auditAppends, [{
      tenantId: TENANT, projectId: PROJECT, action: 'project_pilot_enable', subjectId: sheetId, mode: 'enabled', actor: WORKBENCH_ADMIN.id,
      detail: { objectId, readinessVersion: PILOT_READINESS_VERSION, exportClosureAlreadyClosed: false, generationBumped: true },
    }])
    // GET afterwards: enabled, may.enable false.
    const read = await getPilot(h, WORKBENCH_ADMIN)
    assert.equal(read.body.data.pilot.enabled, true)
    assert.deepEqual(read.body.data.may, { enable: false })
    // The platform admin can enable too (a fresh mount).
    const h2 = mountReady()
    try {
      const res2 = await enablePilot(h2, PLATFORM_ADMIN)
      assert.equal(res2.statusCode, 200, JSON.stringify(res2.body))
      assert.equal(h2.auditAppends[0].actor, PLATFORM_ADMIN.id)
    } finally { h2.restore() }
  } finally { h.restore() }
})

test('P-07 re-POST: the stamp is requested again (alreadyClosed), the mark is alreadyEnabled, NO second audit row; a lost stamp is repaired', async () => {
  const h = mountReady()
  try {
    const { sheetId } = h
    const first = await enablePilot(h, WORKBENCH_ADMIN)
    assert.equal(first.statusCode, 200, JSON.stringify(first.body))
    const stampedAt = h.registryRows()[0].pilot_enabled_at
    const again = await enablePilot(h, PLATFORM_ADMIN)
    assert.equal(again.statusCode, 200, JSON.stringify(again.body))
    assert.equal(again.body.data.enabled, false)
    assert.equal(again.body.data.alreadyEnabled, true)
    assert.deepEqual(again.body.data.exportClosure, { closed: true, alreadyClosed: true })
    assert.equal(again.body.data.pilot.enabledBy, WORKBENCH_ADMIN.id, 'the ORIGINAL stamp')
    assert.equal(h.provisioning.gridExportClosureCalls.length, 2, 'the host was asked again (idempotent)')
    assert.equal(h.registryRows()[0].pilot_enabled_at, stampedAt, 'the registry stamp did not move')
    assert.equal(h.auditAppends.length, 1, 'no second audit row')
    // The host lost the stamp (a runbook mistake, a restore from backup): the re-POST lands it again.
    h.provisioning.gridExportClosures.delete(sheetId)
    const repaired = await enablePilot(h, WORKBENCH_ADMIN)
    assert.equal(repaired.statusCode, 200, JSON.stringify(repaired.body))
    assert.deepEqual(repaired.body.data.exportClosure, { closed: true, alreadyClosed: false })
    assert.equal(repaired.body.data.alreadyEnabled, true)
    assert.ok(h.provisioning.gridExportClosures.has(sheetId), 'the sheet is closed again')
    assert.equal(h.auditAppends.length, 1, 'still one audit row')
    // The generation moved on every POST (an admin act supersedes every earlier plan), never while a writer holds the sheet.
    assert.equal((await h.projectWriteLock.readState(swlLockLib.sheetWriteScopeKey(sheetId))).generation, 3)
  } finally { h.restore() }
})

test('P-08 the tenant wall: another tenant\'s project is ABSENT here; a tenantless platform admin is refused by the operator scope; no probe runs', async () => {
  const h = mountReady()
  try {
    h.seedRegistryRow(OTHER_PROJECT, { tenant: OTHER_TENANT })
    h.provisioning.calls.length = 0
    const foreignGet = await getPilot(h, WORKBENCH_ADMIN, OTHER_PROJECT)
    assert.equal(foreignGet.statusCode, 200)
    assert.equal(foreignGet.body.data.status, 'absent', 'the registry is keyed by the verified tenant')
    const foreignPost = await enablePilot(h, WORKBENCH_ADMIN, OTHER_PROJECT)
    assert.equal(foreignPost.statusCode, 409, JSON.stringify(foreignPost.body))
    assert.equal(foreignPost.body.error.code, 'STOCK_PREPARATION_PROJECT_ABSENT')
    assert.deepEqual(h.provisioning.calls, [], 'no host probe for a project that is not this tenant\'s')
    const tenantless = await enablePilot(h, TENANTLESS_ADMIN)
    assert.equal(tenantless.statusCode, 403, JSON.stringify(tenantless.body))
    assert.equal(tenantless.body.error.code, 'OPERATOR_SCOPE_TENANT_REQUIRED')
    assert.deepEqual(h.auditAppends, [])
    assert.equal(h.registryRows().find((row) => row.tenant_id === OTHER_TENANT).pilot_enabled_at, undefined)
    assert.equal(h.registryRows().find((row) => row.tenant_id === TENANT).pilot_enabled_at, undefined)
  } finally { h.restore() }
})

test('P-09 archived: GET answers the state with readiness null; POST is 409 ARCHIVED, nothing done', async () => {
  const h = mountReady()
  try {
    const row = h.registryRows()[0]
    row.status = 'archived'
    row.archived_at = new Date('2026-10-22T00:00:00Z')
    const read = await getPilot(h, WORKBENCH_ADMIN)
    assert.equal(read.statusCode, 200, JSON.stringify(read.body))
    assert.deepEqual(read.body.data, { projectNo: PROJECT, status: 'archived', pilot: { enabled: false, enabledAt: null, enabledBy: null, readinessVersion: null }, readiness: null, may: { enable: false } })
    const res = await enablePilot(h, WORKBENCH_ADMIN)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
    assert.equal(h.provisioning.gridExportClosureCalls.length, 0)
    assert.deepEqual(h.auditAppends, [])
    assert.equal(row.pilot_enabled_at, undefined)
  } finally { h.restore() }
})

test('P-10 a writer between readiness and the bump: 409 WRITE_LOCKED, nothing stamped / marked / audited; a live lease seen by readiness fails write_lock_free', async () => {
  const h = mountReady()
  try {
    const scope = swlLockLib.sheetWriteScopeKey(h.sheetId)
    // A live lease BEFORE the request: readiness names it.
    const held = await h.projectWriteLock.acquire(scope, { purpose: 'small_apply', runId: 'pb-writer' })
    const seen = await enablePilot(h, WORKBENCH_ADMIN)
    assert.equal(seen.statusCode, 409, JSON.stringify(seen.body))
    assert.equal(seen.body.error.code, PILOT_ERROR_CODES.NOT_READY)
    assert.deepEqual(details(seen).failing, ['write_lock_free'])
    await h.projectWriteLock.createGuard(held).release()
    // A writer that arrives AFTER readiness passed (during the closure read, the last probe) and BEFORE the bump.
    const readOriginal = h.provisioning.getSheetGridExportClosure
    let arrived = null
    h.provisioning.getSheetGridExportClosure = async (input) => {
      const answer = await readOriginal(input)
      if (!arrived) arrived = await h.projectWriteLock.acquire(scope, { purpose: 'small_apply', runId: 'pb-late-writer' })
      return answer
    }
    const raced = await enablePilot(h, WORKBENCH_ADMIN)
    assert.equal(raced.statusCode, 409, JSON.stringify(raced.body))
    assert.equal(raced.body.error.code, swlLockLib.PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
    assert.equal(h.provisioning.gridExportClosureCalls.length, 0, 'no stamp')
    assert.deepEqual(h.auditAppends, [])
    assert.equal(h.registryRows()[0].pilot_enabled_at, undefined, 'not marked')
    assert.equal((await h.projectWriteLock.readState(scope)).generation, 0, 'not bumped')
    await h.projectWriteLock.createGuard(arrived).release()
  } finally { h.restore() }
})

test('P-11 the audit vocabulary probe: a database without migration 101 is 503 before readiness, the lock or the host', async () => {
  const h = mountReady()
  try {
    h.services.stockPreparationAuditStore.supportsAction = async (action) => ({ supported: action !== 'project_pilot_enable', reason: 'check_constraint_rejects' })
    h.provisioning.calls.length = 0
    const res = await enablePilot(h, WORKBENCH_ADMIN)
    assert.equal(res.statusCode, 503, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_AUDIT_VOCABULARY_UNAVAILABLE')
    assert.deepEqual(details(res), { migration: '101' })
    assert.deepEqual(h.provisioning.calls, [], 'no host probe')
    assert.equal((await h.projectWriteLock.readState(swlLockLib.sheetWriteScopeKey(h.sheetId))).generation, 0)
    assert.deepEqual(h.auditAppends, [])
  } finally { h.restore() }
})

// ── the lane refusals ───────────────────────────────────────────────────────────────────────────────

test('L-01 the five large routes refuse a PILOT project 409 LARGE_LANE_REFUSED naming the lane — no job, no read, no write; L05: a NON-pilot project is served as before', async () => {
  const run = async ({ pilot }) => {
    const h = mount()
    try {
      const { sheetId, objectId } = h.seedRegistryRow(PROJECT)
      const target = { sheetId, objectId, fieldIdMap: {} }
      if (pilot) markPilotDirectly(h)
      const results = {}
      // start
      const started = await expansionStart(h)
      results.start = started
      // run: a queued job owned by the caller
      await seedPlannedExpansionJob(h, { jobId: 'job-pb-run', target, status: 'queued' })
      const sourceReadsBefore = h.source.calls.length
      results.run = await expansionRun(h, 'job-pb-run')
      results.sourceReadsDuringRun = h.source.calls.length - sourceReadsBefore
      // plan / approve on a planned expansion
      await seedPlannedExpansionJob(h, { jobId: 'job-pb-plan', target })
      results.plan = await plan(h, 'job-pb-plan')
      results.approve = await applyStart(h, 'job-pb-plan')
      // chunk: approve first on a NON-pilot copy of the state is not possible on the same mount, so the chunk leg
      // of the pilot case seeds the approval through the lib (see L-02 for the full sequence); here the route is
      // driven with the apply job the approval made (non-pilot) or refused before any job exists (pilot).
      const applyJobId = results.approve.statusCode === 202 ? results.approve.body.data.jobId : null
      results.chunk = applyJobId ? await applyRun(h, 'job-pb-plan', applyJobId) : null
      results.writes = h.records.calls.filter(([verb]) => verb === 'createRecord' || verb === 'patchRecord').length
      results.jobs = [...h.context.storage.keys()].filter((key) => key.includes('large-bom')).length
      return results
    } finally { h.restore() }
  }
  const pilot = await run({ pilot: true })
  for (const [lane, res] of [['large_expansion_start', pilot.start], ['large_expansion_run', pilot.run], ['large_plan', pilot.plan], ['large_approve', pilot.approve]]) {
    assert.equal(res.statusCode, 409, `${lane}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.error.code, PILOT_ERROR_CODES.LARGE_LANE_REFUSED, lane)
    assert.deepEqual(details(res), { lane, reason: 'pilot_project', byProject: true, bySheet: true, partial: false })
    assert.ok(!JSON.stringify(res.body).includes(TENANT), 'values-free')
  }
  assert.equal(pilot.sourceReadsDuringRun, 0, 'the refused run read nothing from the source')
  assert.equal(pilot.writes, 0, 'zero record writes')
  assert.equal(pilot.chunk, null, 'no apply job was ever created for the pilot project')
  const plain = await run({ pilot: false })
  assert.equal(plain.start.statusCode, 202, `L05 start: ${JSON.stringify(plain.start.body)}`)
  assert.equal(plain.run.statusCode, 200, `L05 run: ${JSON.stringify(plain.run.body)}`)
  assert.equal(plain.plan.statusCode, 200, `L05 plan: ${JSON.stringify(plain.plan.body)}`)
  assert.equal(plain.approve.statusCode, 202, `L05 approve: ${JSON.stringify(plain.approve.body)}`)
  assert.equal(plain.chunk.statusCode, 200, `L05 chunk: ${JSON.stringify(plain.chunk.body)}`)
  assert.ok(plain.sourceReadsDuringRun > 0, 'the non-pilot run read its source')
})

test('L-02 a job approved BEFORE the enablement: the chunk answers the PILOT code (not PLAN_SUPERSEDED), the job stays queued, zero writes; the in-lease check alone refuses before running', async () => {
  const h = mount()
  try {
    const { sheetId, objectId } = h.seedRegistryRow(PROJECT)
    const target = { sheetId, objectId, fieldIdMap: {} }
    await seedPlannedExpansionJob(h, { jobId: 'job-pb-before', target })
    assert.equal((await plan(h, 'job-pb-before')).statusCode, 200)
    const approved = await applyStart(h, 'job-pb-before')
    assert.equal(approved.statusCode, 202, JSON.stringify(approved.body))
    const applyJobId = approved.body.data.jobId
    const scope = swlLockLib.sheetWriteScopeKey(sheetId)
    // THE ENABLEMENT, as the route performs it on the lock: the marker lands AND the generation is bumped.
    markPilotDirectly(h)
    await h.projectWriteLock.bumpGeneration(scope, { reason: 'pilot_enable', tenantId: TENANT })
    const before = JSON.stringify(await h.context.storage.get(checkpointKey(applyJobId)))
    const res = await applyRun(h, 'job-pb-before', applyJobId)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, PILOT_ERROR_CODES.LARGE_LANE_REFUSED, 'the pilot code wins over PLAN_SUPERSEDED')
    assert.equal(res.body.error.details.lane, 'large_apply_chunk')
    const stored = await h.context.storage.get(checkpointKey(applyJobId))
    assert.equal(JSON.stringify(stored), before, 'the job is exactly as it was')
    assert.equal(stored.status, 'queued', 'never running')
    assert.equal(h.records.calls.filter(([verb]) => verb === 'createRecord' || verb === 'patchRecord').length, 0, 'zero record writes')
    assert.equal((await h.projectWriteLock.readState(scope)).leaseHeld, false)
    // THE IN-LEASE CHECK ALONE: the route gate reads not-pilot (the marker lands between the gate and the lease),
    // the lib's in-lease check reads pilot — refused before the binding compare and before `running`.
    const h2 = mount()
    try {
      const seeded = h2.seedRegistryRow(PROJECT)
      const target2 = { sheetId: seeded.sheetId, objectId: seeded.objectId, fieldIdMap: {} }
      await seedPlannedExpansionJob(h2, { jobId: 'job-pb-race', target: target2 })
      assert.equal((await plan(h2, 'job-pb-race')).statusCode, 200)
      const approved2 = await applyStart(h2, 'job-pb-race')
      assert.equal(approved2.statusCode, 202, JSON.stringify(approved2.body))
      const applyJobId2 = approved2.body.data.jobId
      const scope2 = swlLockLib.sheetWriteScopeKey(seeded.sheetId)
      // The marker lands AFTER the route gate's two reads (by project, by sheet) and BEFORE the in-lease check's
      // reads: the gate answers not pilot, the lib's check answers pilot. The generation has NOT moved, so the
      // binding compare would pass and the empty plan would complete the job — the ONLY thing that can refuse
      // here is the in-lease pilot check (drop it and the job ends `succeeded`: red).
      let pilotReads = 0
      const wrapPilotRead = (original) => async (input) => {
        pilotReads += 1
        if (pilotReads === 3) markPilotDirectly(h2)
        return original.call(h2.projectTargetStore, input)
      }
      h2.projectTargetStore.getPilotState = wrapPilotRead(h2.projectTargetStore.getPilotState)
      h2.projectTargetStore.getPilotStateBySheetId = wrapPilotRead(h2.projectTargetStore.getPilotStateBySheetId)
      const before2 = JSON.stringify(await h2.context.storage.get(checkpointKey(applyJobId2)))
      const res2 = await applyRun(h2, 'job-pb-race', applyJobId2)
      assert.equal(res2.statusCode, 409, JSON.stringify(res2.body))
      assert.equal(res2.body.error.code, PILOT_ERROR_CODES.LARGE_LANE_REFUSED, 'the in-lease check refused')
      const stored2 = await h2.context.storage.get(checkpointKey(applyJobId2))
      assert.equal(JSON.stringify(stored2), before2, 'the job was never persisted running')
      assert.equal(stored2.status, 'queued')
      assert.equal(h2.records.calls.filter(([verb]) => verb === 'createRecord' || verb === 'patchRecord').length, 0)
      assert.equal((await h2.projectWriteLock.readState(scope2)).leaseHeld, false, 'the lease was released')
      assert.equal(pilotReads, 4, 'the route gate read twice (not pilot); the in-lease check read twice more (by project, by sheet) and refused')
      assert.ok(registryReadCount(h2) >= 3, 'the registry answered every pilot read')
    } finally { h2.restore() }
  } finally { h.restore() }
})

test('L-03 over the small-lane cap: a pilot project\'s dry run is 409 SMALL_LANE_LIMIT_EXCEEDED (no token, pull stamped refused); a non-pilot project answers large_bom_bounded byte for byte', async () => {
  const run = async ({ pilot }) => {
    // The golden two-row BOM through an action capped at ONE row: every run is bounded.
    const source = kit.createSourceAdapter(kit.goldenPlmData(PROJECT))
    const h = mount({
      configExtras: {
        stockPreparationTableActions: [{
          actionId: ACTION_ID,
          source: { externalSystemId: 'plm_sql_source_synthetic', kind: 'data-source:sql-readonly' },
          target: { sheetId: 'sheet_env_synthetic', objectId: 'plm_stock_preparation_sandbox_synthetic_env', fieldIdMap: {} },
          maxRows: 1,
        }],
      },
      serviceExtras: { adapterRegistry: { createAdapter() { return source.adapter }, listAdapterKinds() { return [] } } },
    })
    try {
      h.seedRegistryRow(PROJECT)
      if (pilot) markPilotDirectly(h)
      const res = await dryRun(h)
      const tokens = [...h.context.storage.keys()].filter((key) => key.includes('dry-run')).length
      return { res, tokens, row: { ...h.registryRows()[0] }, writes: h.records.calls.filter(([verb]) => verb !== 'queryRecords').length }
    } finally { h.restore() }
  }
  const plain = await run({ pilot: false })
  assert.equal(plain.res.statusCode, 200, `calibration: ${JSON.stringify(plain.res.body)}`)
  assert.equal(plain.res.body.data.status, 'large_bom_bounded', 'calibration: the golden BOM exceeds maxRows 1')
  assert.equal(plain.res.body.data.dryRunToken, null)
  const pilot = await run({ pilot: true })
  assert.equal(pilot.res.statusCode, 409, JSON.stringify(pilot.res.body))
  assert.equal(pilot.res.body.error.code, PILOT_ERROR_CODES.SMALL_LANE_LIMIT_EXCEEDED)
  assert.deepEqual(details(pilot.res), { reason: 'pilot_project', byProject: true, bySheet: true, partial: false })
  assert.equal(pilot.tokens, 0, 'no token')
  assert.equal(pilot.writes, 0, 'no write')
  assert.equal(pilot.row.last_pull_outcome, 'refused', 'the pull is stamped refused')
  assert.equal(pilot.row.last_pull_code, PILOT_ERROR_CODES.SMALL_LANE_LIMIT_EXCEEDED)
  assert.equal(plain.row.last_pull_outcome, 'previewed')
})

test('L-04 split / re-entry: the pilot project through another sheet is refused by project identity; another project through the pilot sheet by sheet identity — switch OFF included', async () => {
  // (a) switch ON: a job snapshot that targets ANOTHER sheet but carries the pilot project number. The staleness
  // check would also refuse it (the snapshot is not the registered sheet) — so the gate is driven at the lib seam
  // the routes call, with the same inputs the routes pass.
  const gateModule = require(path.join(LIB, 'stock-preparation-pilot-gate.cjs'))
  const h = mount()
  try {
    const { sheetId } = h.seedRegistryRow(PROJECT)
    const other = h.seedRegistryRow(OTHER_PROJECT)
    markPilotDirectly(h)
    const gate = gateModule.createStockPreparationPilotGate({ store: h.projectTargetStore })
    const byProject = await gate.readPilotState({ tenantId: TENANT, projectNo: PROJECT, sheetId: other.sheetId })
    assert.deepEqual(byProject, { state: 'pilot', byProject: true, bySheet: false, registry: 'present' })
    const bySheet = await gate.readPilotState({ tenantId: TENANT, projectNo: OTHER_PROJECT, sheetId })
    assert.deepEqual(bySheet, { state: 'pilot', byProject: false, bySheet: true, registry: 'present' })
  } finally { h.restore() }
  // (b) switch OFF: no overlay, no staleness check — the pilot SHEET through another project number is refused by
  // the sheet read; the pilot PROJECT through the env sheet by the project read.
  const off = mount({ switchOn: false })
  try {
    const { sheetId, objectId } = off.seedRegistryRow(PROJECT)
    markPilotDirectly(off)
    const envTarget = { sheetId: 'sheet_env_synthetic', objectId: 'plm_stock_preparation_sandbox_synthetic_env', fieldIdMap: {} }
    await seedPlannedExpansionJob(off, { jobId: 'job-pb-off-project', target: envTarget, projectNo: PROJECT })
    const viaEnv = await plan(off, 'job-pb-off-project')
    assert.equal(viaEnv.statusCode, 409, JSON.stringify(viaEnv.body))
    assert.equal(viaEnv.body.error.code, PILOT_ERROR_CODES.LARGE_LANE_REFUSED)
    assert.deepEqual(details(viaEnv), { lane: 'large_plan', reason: 'pilot_project', byProject: true, bySheet: false, partial: false })
    await seedPlannedExpansionJob(off, { jobId: 'job-pb-off-sheet', target: { sheetId, objectId, fieldIdMap: {} }, projectNo: OTHER_PROJECT })
    const viaSheet = await plan(off, 'job-pb-off-sheet')
    assert.equal(viaSheet.statusCode, 409, JSON.stringify(viaSheet.body))
    assert.deepEqual(details(viaSheet), { lane: 'large_plan', reason: 'pilot_project', byProject: false, bySheet: true, partial: false })
    // And the start route, switch off, by project number alone (the env sheet is the target).
    const started = await expansionStart(off, PROJECT)
    assert.equal(started.statusCode, 409, JSON.stringify(started.body))
    assert.deepEqual(details(started), { lane: 'large_expansion_start', reason: 'pilot_project', byProject: true, bySheet: false, partial: false })
    // A project that is not pilot, switch off: served as before.
    await seedPlannedExpansionJob(off, { jobId: 'job-pb-off-plain', target: envTarget, projectNo: OTHER_PROJECT })
    assert.equal((await plan(off, 'job-pb-off-plain')).statusCode, 200)
  } finally { off.restore() }
})

test('L-05 source order: the gate follows the staleness check and precedes every IO and the lease in all five handlers; the chunk and the dry run hand the lib their hooks', () => {
  const body = (handler) => {
    const start = HTTP_ROUTES_SOURCE.indexOf(`    async ${handler}(req, res) {`)
    assert.notEqual(start, -1, `${handler} exists`)
    return HTTP_ROUTES_SOURCE.slice(start, HTTP_ROUTES_SOURCE.indexOf('\n    },', start))
  }
  const ROUTES = {
    tableActionLargeBomExpansionJobStart: { lane: 'large_expansion_start', after: ['assertResolvedProjectTargetTenancy('], before: ['createLargeBomBackgroundExpansionJob(', 'observeGeneration('] },
    tableActionLargeBomExpansionJobRun: { lane: 'large_expansion_run', after: ['assertLargeBomJobActor('], before: ['assertB2aReadAuthorization(', 'loadTableActionSourceAdapter(', 'runLargeBomBackgroundExpansionJob('] },
    tableActionLargeBomExpansionJobPlan: { lane: 'large_plan', after: ['assertLargeBomJobTargetMatchesProjectTarget('], before: ['assertTargetFieldsExist(', 'readExistingStockPreparationRows(', 'assertTargetSheetHoldsNoForeignActiveRows(', 'planLargeBomBackgroundExpansionJob('] },
    tableActionLargeBomApplyJobStart: { lane: 'large_approve', after: ['assertLargeBomJobTargetMatchesProjectTarget('], before: ['assertTargetFieldsExist(', 'assertTargetSheetHoldsNoForeignActiveRows(', 'createLargeBomCheckpointApplyJob(', 'bumpGeneration('] },
    tableActionLargeBomApplyJobRun: { lane: 'large_apply_chunk', after: ['assertLargeBomJobTargetMatchesProjectTarget('], before: ['assertTargetFieldsExist(', 'assertTargetSheetHoldsNoForeignActiveRows(', 'assertStockPrepApplyAllowed(', 'withProjectWriteLease(', 'runLargeBomCheckpointApplyJobChunk('] },
  }
  for (const [handler, spec] of Object.entries(ROUTES)) {
    const text = body(handler)
    const gateAt = text.indexOf(`'${spec.lane}')`)
    assert.notEqual(gateAt, -1, `${handler}: calls the gate for lane ${spec.lane}`)
    assert.ok(text.slice(0, gateAt).includes('assertLargeLaneAllowedForPilot('), `${handler}: the gate call is the pilot gate`)
    for (const marker of spec.after) {
      const at = text.lastIndexOf(marker, gateAt)
      assert.notEqual(at, -1, `${handler}: ${marker} precedes the gate`)
    }
    for (const marker of spec.before) {
      const at = text.indexOf(marker)
      if (at !== -1) assert.ok(gateAt < at, `${handler}: the gate precedes ${marker}`)
    }
    // The C-06 scan's slicing rule: no object literal closes at 4-space indent inside the handler (the gate call is one line).
    assert.ok(!/\n {4}\},\n/.test(text), handler + ': no object literal closes at 4-space indent inside the handler body (C-06 slicing rule)')
  }
  const chunk = body('tableActionLargeBomApplyJobRun')
  assert.match(chunk, /largeLanePilotCheck: \(\{ target \}\) => assertLargeLaneAllowedForPilot\(/, 'the chunk hands the lib the in-lease check')
  assert.ok(chunk.indexOf('largeLanePilotCheck:') < chunk.indexOf('projectWriteGuard,'), 'listed with the guard it runs under')
  const dry = body('tableActionDryRun')
  assert.match(dry, /pilotLaneGuard: \(\) => stockPreparationPilotGate\.assertSmallLaneCapNotExceededForPilot\(/, 'the dry run hands the lib the over-cap guard')
  // The lib seams exist and sit where the design puts them.
  const libSource = fs.readFileSync(path.join(LIB, 'stock-preparation-large-bom-jobs.cjs'), 'utf8')
  const chunkFn = libSource.slice(libSource.indexOf('async function runLargeBomCheckpointApplyJobChunk('))
  const checkAt = chunkFn.indexOf('input.largeLanePilotCheck')
  assert.notEqual(checkAt, -1)
  assert.ok(checkAt < chunkFn.indexOf('assertWriteBindingMatchesGuard('), 'before the binding compare')
  assert.ok(checkAt < chunkFn.indexOf("job.status = 'running'"), 'before running')
  const taSource = fs.readFileSync(path.join(LIB, 'stock-preparation-table-actions.cjs'), 'utf8')
  const dryFn = taSource.slice(taSource.indexOf('async function dryRunStockPreparationAction('))
  const guardAt = dryFn.indexOf('input.pilotLaneGuard')
  assert.notEqual(guardAt, -1)
  assert.ok(guardAt < dryFn.indexOf('createDryRunToken('), 'before the token block')
})

test('L-06 an unreadable marker: every large route and the over-cap dry run answer 503 STATE_UNREADABLE and never proceed', async () => {
  const h = mount()
  try {
    const { sheetId, objectId } = h.seedRegistryRow(PROJECT)
    const target = { sheetId, objectId, fieldIdMap: {} }
    await seedPlannedExpansionJob(h, { jobId: 'job-pb-unreadable', target })
    await seedPlannedExpansionJob(h, { jobId: 'job-pb-unreadable-queued', target, status: 'queued' })
    // The PILOT reads fail (the registry's other reads — the overlay — still answer): what the lane gate sees.
    const failure = Object.assign(new Error('relation "integration_stock_prep_project_target" does not exist'), { code: '42P01' })
    h.projectTargetStore.getPilotState = async () => { throw failure }
    h.projectTargetStore.getPilotStateBySheetId = async () => { throw failure }
    for (const [label, run] of [
      ['start', () => expansionStart(h)],
      ['run', () => expansionRun(h, 'job-pb-unreadable-queued')],
      ['plan', () => plan(h, 'job-pb-unreadable')],
      ['approve', () => applyStart(h, 'job-pb-unreadable')],
    ]) {
      const res = await run()
      assert.equal(res.statusCode, 503, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, PILOT_ERROR_CODES.STATE_UNREADABLE, label)
      assert.deepEqual(details(res), { operation: 'pilot_state_read', sqlState: '42P01', partial: false }, label)
      assert.ok(!JSON.stringify(res.body).includes('does not exist'), 'the store message never travels')
    }
    assert.equal(h.records.calls.filter(([verb]) => verb === 'createRecord' || verb === 'patchRecord').length, 0)
  } finally { h.restore() }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pilot-routes.test.cjs', tests, { passLine: '✓ stock-preparation-pilot-routes' })
