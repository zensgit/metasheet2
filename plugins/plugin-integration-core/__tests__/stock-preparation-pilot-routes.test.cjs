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
//   P-12 (pre-enable hardening F-4b) THE 501 WIRING GUARD, clause by clause — markPilotEnabled included (the harness
//        store always offers it, so without this case the clause was a mutation survivor): GET and POST 501, zero IO
//   P-13 (F-4c) THE AUDIT ROW COMMITS WITH THE MARK: a crash at the audit write leaves export-closed-not-pilot and no
//        row; the re-POST writes exactly one; a third POST none; an audit store without the in-transaction append is
//        501 before any IO; a store that marks without running the hook is 500, never 200
//   P-14 (F-3) no_open_large_job through the real routes: a queued approval on the sheet refuses enabling (nothing
//        done); another sheet's job does not; running the job to its end clears it; an unlistable store fails it; a
//        job that lands between the readiness scan and the enable's lease is caught by the scan UNDER the lease
//   P-15 (F-5 / O-6) no_two_copy_component through the real routes: refused with nothing done; the copy inactive enables
//   P-16 (F-5 / O-8) pack_columns_installed through the real routes: declared ⇒ ledger AND host; nothing declared ⇒ refused
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
//   PR-N4 (S1 N4, review candidate) spec_read_plan_slot with the online read-plan switch ON: the deployment plan AND
//        the effective plan must both declare the 规格 column, or the server declares it not applicable (a) deployment
//        only ⇒ failing, ENABLE refused with nothing done; (b) online only ⇒ failing (today's answer); (c) both ⇒ ok;
//        (d) a disabled pointer ⇒ failing; (e) switch unset ⇒ P-04 / P-05 as today, no pointer read; (f) declared not
//        applicable ⇒ ok without asking for any plan; (g, S1b) a binding set naming two systems ⇒ failing before any
//        pointer read (the effective resolver refuses it)
//
// Synthetic values only.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
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
const { PLM_STOCK_PREPARATION_ACTION_ID, createStockPreparationTableActionRegistry } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { PROJECT_SHEETS_ENABLED_ENV, PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS, resolveProjectTargetForAction } = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE, normalizeStockPreparationTemplate } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { templateContractOptionFields } = require(path.join(LIB, 'stock-preparation-option-sync.cjs'))
const { PILOT_ERROR_CODES } = require(path.join(LIB, 'stock-preparation-pilot-gate.cjs'))
const { CUSTOMER_PACK_NOT_APPLICABLE, PILOT_READINESS_CHECK_IDS, PILOT_READINESS_VERSION, SPEC_READ_PLAN_SLOT_NOT_APPLICABLE } = require(path.join(LIB, 'stock-preparation-pilot-readiness.cjs'))
const continuationSupport = require(path.join(LIB, 'stock-preparation-continuation-support.cjs'))
const largeBomJobs = require(path.join(LIB, 'stock-preparation-large-bom-jobs.cjs'))
const swlLockLib = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const { ONLINE_READ_PLANS_ENABLED_ENV } = require(path.join(LIB, 'stock-preparation-read-plan-switch.cjs'))
const { StockPreparationReadPlanStoreError } = require(path.join(LIB, 'stock-preparation-read-plan-store.cjs'))
const { validateStockPreparationReadPlanConfig } = require(path.join(LIB, 'stock-preparation-read-plan-config.cjs'))
assert.equal(typeof resolveProjectTargetForAction, 'function', 'the real project-target resolver is the one the registry producer path uses')

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
    // Pre-enable hardening (readiness version 2): the deployment also declares it runs without a customer pack.
    configExtras: { stockPreparationPilot: { specReadPlanSlot: SPEC_READ_PLAN_SLOT_NOT_APPLICABLE, customerPack: CUSTOMER_PACK_NOT_APPLICABLE } },
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

/**
 * A planned, authoritative expansion job minted by the REAL producers (create -> run -> plan), so it carries the
 * producer's own v3 identity and revisions — none is filled by hand. `status: 'queued'` stops after create (the
 * run route's input). Only what the routes record around the producers is stamped on: the target sheet's write
 * generation observed from the mounted lock. `deliberateTargetSplit` is the L-04 fixture alone: a job whose
 * snapshot names a sheet the registry would not resolve for this project number; the target is then an explicit
 * producer INPUT, the minted identity is still the producer's.
 */
async function seedPlannedExpansionJob(h, { jobId, target, projectNo = PROJECT, status = 'completed', deliberateTargetSplit = false }) {
  assert.ok(['completed', 'queued'].includes(status), `unsupported seed status ${status}`)
  const actionId = ACTION_ID
  const at = '2026-10-23T00:00:00.000Z'
  const seedLock = h.projectWriteLock
  const writeObservation = seedLock && target && typeof target.sheetId === 'string'
    ? swlLockLib.writeObservationFromGeneration(await seedLock.observeGeneration(swlLockLib.sheetWriteScopeKey(target.sheetId)))
    : null
  const registry = createStockPreparationTableActionRegistry({
    actions: h.context.config.stockPreparationTableActions,
    resolveProjectTarget: (input) => resolveProjectTargetForAction({
      ...input, store: h.projectTargetStore, provisioning: h.provisioning, projectId: h.staging, env: process.env,
    }),
  })
  const resolved = await registry.getTableAction({ ...JOB_SCOPE, actionId, projectNo, targetPurpose: 'write' })
  let action = resolved
  if (deliberateTargetSplit) {
    action = { ...resolved, target: { ...resolved.target, sheetId: target.sheetId, objectId: target.objectId } }
  } else {
    assert.equal(resolved.target.sheetId, target.sheetId, 'producer uses the actual resolved sheet')
    assert.equal(resolved.target.objectId, target.objectId, 'producer uses the actual resolved object')
  }
  await largeBomJobs.createLargeBomBackgroundExpansionJob({
    storage: h.context.storage, ...JOB_SCOPE, action,
    parameters: { projectNo },
    principal: PLATFORM_ADMIN.id, actor: PLATFORM_ADMIN.id, createJobId: () => jobId, now: () => at,
  })
  const jobKey = largeBomJobs.__internals.backgroundJobKey({ ...JOB_SCOPE, actionId, jobId })
  if (status === 'queued') {
    const queued = await h.context.storage.get(jobKey)
    assert.equal(queued && queued.status, 'queued', 'the real create leaves the job queued')
    if (!writeObservation) return queued
    const observedQueued = { ...queued, writeObservation }
    await h.context.storage.set(jobKey, observedQueued)
    return observedQueued
  }
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
  const stored = await h.context.storage.get(jobKey)
  assert.equal(stored && stored.jobId, jobId, 'the planned job is stored under its background-job key')
  const observed = { ...stored, writeObservation, planWriteObservation: writeObservation }
  await h.context.storage.set(jobKey, observed)
  return observed
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
    // no 规格 declaration, no customer-pack declaration (pack_columns_installed, readiness version 2), inert
    // registries, and the shipped build marker.
    assert.deepEqual(data.readiness.failing, ['plm_column_lock', 'contract_option_sets', 'export_closure_port', 'spec_read_plan_slot', 'pack_columns_installed', 'no_generic_writer_names_sheet', 'continuation_support_version'])
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
    assert.deepEqual(details(res), { version: PILOT_READINESS_VERSION, failing: ['plm_column_lock', 'contract_option_sets', 'export_closure_port', 'spec_read_plan_slot', 'pack_columns_installed', 'no_generic_writer_names_sheet', 'continuation_support_version'], partial: false })
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
    h.projectTargetStore.markPilotEnabled = async (input) => { order.push('mark'); const marked = await markOriginal(input); order.push('mark-committed'); return marked }
    // F-4(c): the audit row rides the MARK's transaction — the in-transaction append, never the plain one.
    const appendOriginal = h.services.stockPreparationAuditStore.append
    h.services.stockPreparationAuditStore.append = async (entry) => { order.push('plain-append'); return appendOriginal(entry) }
    const appendWithinOriginal = h.services.stockPreparationAuditStore.appendWithin
    let markedWhenAudited = null
    h.services.stockPreparationAuditStore.appendWithin = async (trx, entry) => {
      markedWhenAudited = h.registryRows()[0].pilot_enabled_at instanceof Date
      order.push('audit')
      return appendWithinOriginal(trx, entry)
    }
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
    // Order: the stamp inside the lease, after the bump; then the mark, whose transaction writes the audit row
    // after the compare-and-set and BEFORE it returns (F-4(c)); the plain append is never used.
    assert.deepEqual(order, ['stamp', 'mark', 'audit', 'mark-committed'])
    assert.equal(markedWhenAudited, true, 'the audit row was written after the compare-and-set, in the same transaction')
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

// ── pre-enable hardening (step-4 design §23.4 F-3 / F-4 / F-5) ─────────────────────────────────────────

test('P-12 (F-4b) the 501 wiring guard: a registry store missing ANY pilot method — markPilotEnabled included — is 501 on GET and POST with zero registry / host IO, nothing bumped', async () => {
  for (const method of ['getPilotState', 'getPilotStateBySheetId', 'markPilotEnabled', 'probeTableReadable']) {
    const h = mountReady()
    try {
      const scope = swlLockLib.sheetWriteScopeKey(h.sheetId)
      h.projectTargetStore[method] = undefined
      h.db.calls.length = 0
      h.provisioning.calls.length = 0
      for (const [label, run] of [['GET', getPilot], ['POST', enablePilot]]) {
        const res = await run(h, WORKBENCH_ADMIN)
        assert.equal(res.statusCode, 501, `${method} missing, ${label}: ${JSON.stringify(res.body)}`)
        assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_STORE_UNAVAILABLE', `${method} missing, ${label}`)
      }
      assert.deepEqual(h.db.calls, [], `${method} missing: no registry statement`)
      assert.deepEqual(h.provisioning.calls, [], `${method} missing: no host call (no readiness probe, no stamp)`)
      assert.equal((await h.projectWriteLock.readState(scope)).generation, 0, `${method} missing: nothing bumped`)
      assert.deepEqual(h.auditAppends, [])
      assert.equal(h.registryRows()[0].pilot_enabled_at, undefined)
    } finally { h.restore() }
  }
})

test('P-13 (F-4c) the audit row commits WITH the mark: a crash between them leaves export-closed-not-pilot and NO row; the re-POST writes exactly one; a third POST none; an audit store without the in-transaction append, or a store that skips the hook, is refused', async () => {
  // (a) an audit store that cannot write inside the mark transaction: 501 before ANY IO.
  {
    const h = mountReady()
    try {
      h.services.stockPreparationAuditStore.appendWithin = undefined
      h.db.calls.length = 0
      h.provisioning.calls.length = 0
      const res = await enablePilot(h, WORKBENCH_ADMIN)
      assert.equal(res.statusCode, 501, JSON.stringify(res.body))
      assert.equal(res.body.error.code, 'AUDIT_STORE_UNAVAILABLE')
      assert.deepEqual(h.db.calls, [], 'no registry statement')
      assert.deepEqual(h.provisioning.calls, [], 'no readiness probe, no stamp')
      assert.equal((await h.projectWriteLock.readState(swlLockLib.sheetWriteScopeKey(h.sheetId))).generation, 0)
      assert.equal(h.registryRows()[0].pilot_enabled_at, undefined)
    } finally { h.restore() }
  }
  // (b) THE CRASH. The harness memory db applies writes at once; give its transaction PostgreSQL's rollback (the
  // registry rows AND the audit rows written on that transaction are restored when its callback throws) — the
  // real-database proof of the same property is H-02 in the real-DB cases module.
  {
    const h = mountReady()
    try {
      const { sheetId } = h
      const transactionOriginal = h.db.transaction
      h.db.transaction = async (fn) => {
        const registryBefore = h.registryRows().map((r) => ({ ...r }))
        const auditBefore = h.auditAppends.length
        try {
          return await transactionOriginal.call(h.db, fn)
        } catch (error) {
          h.registryRows().splice(0, h.registryRows().length, ...registryBefore)
          h.auditAppends.length = auditBefore
          throw error
        }
      }
      // One crash at the audit write — whichever seam the route uses (a route that wrote the row AFTER the mark,
      // outside its transaction, crashes here too and leaves the mark without a row: that is what this pins).
      let crashes = 1
      const crash = () => Object.assign(new Error('synthetic crash between the mark and its audit row'), { code: '08006' })
      const audit = h.services.stockPreparationAuditStore
      const appendWithinOriginal = audit.appendWithin
      const appendOriginal = audit.append
      audit.appendWithin = async (trx, entry) => { if (crashes > 0) { crashes -= 1; throw crash() } return appendWithinOriginal(trx, entry) }
      audit.append = async (entry) => { if (crashes > 0) { crashes -= 1; throw crash() } return appendOriginal(entry) }
      const crashed = await enablePilot(h, WORKBENCH_ADMIN)
      assert.equal(crashed.statusCode, 500, JSON.stringify(crashed.body))
      assert.equal(crashes, 0, 'calibration: the crash fired')
      assert.ok(h.provisioning.gridExportClosures.has(sheetId), 'the stamp landed first: the sheet is export-closed')
      assert.equal(h.registryRows()[0].pilot_enabled_at ?? null, null, 'the mark rolled back with its row: NOT pilot')
      assert.equal(h.auditAppends.length, 0, 'no audit row')
      const afterCrash = await h.projectWriteLock.readState(swlLockLib.sheetWriteScopeKey(sheetId))
      assert.equal(afterCrash.leaseHeld, false, 'the lease was released')
      // The runbook's remedy: enable answered 500 ⇒ POST again. It completes the enable and writes THE row.
      const again = await enablePilot(h, WORKBENCH_ADMIN)
      assert.equal(again.statusCode, 200, JSON.stringify(again.body))
      assert.equal(again.body.data.enabled, true)
      assert.equal(again.body.data.alreadyEnabled, false)
      assert.deepEqual(again.body.data.exportClosure, { closed: true, alreadyClosed: true })
      assert.ok(h.registryRows()[0].pilot_enabled_at instanceof Date)
      assert.equal(h.auditAppends.length, 1, 'exactly one audit row')
      assert.equal(h.auditAppends[0].action, 'project_pilot_enable')
      assert.equal(h.auditAppends[0].detail.exportClosureAlreadyClosed, true, 'the row says the stamp was already there')
      // A further POST (stamp repair only) writes none.
      const third = await enablePilot(h, PLATFORM_ADMIN)
      assert.equal(third.statusCode, 200, JSON.stringify(third.body))
      assert.equal(third.body.data.alreadyEnabled, true)
      assert.equal(h.auditAppends.length, 1, 'still exactly one audit row')
    } finally { h.restore() }
  }
  // (c) a registry store that marks WITHOUT running the hook (a wiring defect): the route says so (500), never 200.
  {
    const h = mountReady()
    try {
      const markOriginal = h.projectTargetStore.markPilotEnabled
      h.projectTargetStore.markPilotEnabled = async (input) => markOriginal({ ...input, onMarked: undefined })
      const res = await enablePilot(h, WORKBENCH_ADMIN)
      assert.equal(res.statusCode, 500, JSON.stringify(res.body))
      assert.equal(res.body.error.code, 'AUDIT_STORE_UNAVAILABLE')
      assert.equal(h.auditAppends.length, 0)
    } finally { h.restore() }
  }
})

test('P-14 (F-3) no_open_large_job: a real approved (queued) checkpoint job on the sheet refuses enabling with nothing done; another sheet\'s job does not; finishing the job clears it; a job store that cannot list fails the check', async () => {
  const h = mountReady()
  try {
    const { sheetId, objectId } = h
    const scope = swlLockLib.sheetWriteScopeKey(sheetId)
    // Another project's sheet with its own approved job: not this sheet's business.
    const other = h.seedRegistryRow(OTHER_PROJECT)
    await seedPlannedExpansionJob(h, { jobId: 'job-peh-other', target: { sheetId: other.sheetId, objectId: other.objectId, fieldIdMap: {} }, projectNo: OTHER_PROJECT })
    assert.equal((await plan(h, 'job-peh-other')).statusCode, 200)
    const otherApproved = await applyStart(h, 'job-peh-other')
    assert.equal(otherApproved.statusCode, 202, JSON.stringify(otherApproved.body))
    const clean = await getPilot(h, WORKBENCH_ADMIN)
    assert.deepEqual(clean.body.data.readiness.failing, [], 'another sheet\'s open job does not count')
    // THIS sheet: approved before the enable, queued, never run.
    await seedPlannedExpansionJob(h, { jobId: 'job-peh-mine', target: { sheetId, objectId, fieldIdMap: {} } })
    assert.equal((await plan(h, 'job-peh-mine')).statusCode, 200)
    const approved = await applyStart(h, 'job-peh-mine')
    assert.equal(approved.statusCode, 202, JSON.stringify(approved.body))
    const applyJobId = approved.body.data.jobId
    assert.equal((await h.context.storage.get(checkpointKey(applyJobId))).status, 'queued', 'calibration: an open job')
    const seen = await getPilot(h, WORKBENCH_ADMIN)
    assert.deepEqual(seen.body.data.readiness.failing, ['no_open_large_job'])
    assert.deepEqual(seen.body.data.may, { enable: false })
    const generationBefore = (await h.projectWriteLock.readState(scope)).generation
    const refused = await enablePilot(h, WORKBENCH_ADMIN)
    assert.equal(refused.statusCode, 409, JSON.stringify(refused.body))
    assert.equal(refused.body.error.code, PILOT_ERROR_CODES.NOT_READY)
    assert.deepEqual(details(refused).failing, ['no_open_large_job'])
    assert.equal((await h.projectWriteLock.readState(scope)).generation, generationBefore, 'nothing bumped')
    assert.equal(h.provisioning.gridExportClosureCalls.length, 0, 'no stamp')
    assert.deepEqual(h.auditAppends, [])
    assert.equal(h.registryRows().find((row) => row.project_no === PROJECT).pilot_enabled_at, undefined)
    assert.ok(!JSON.stringify(refused.body).includes(applyJobId), 'values-free: no job id in the refusal')
    // 旧作业处置 (runbook): run the old job to its end BEFORE enabling — then the check clears and the enable lands.
    const ran = await applyRun(h, 'job-peh-mine', applyJobId)
    assert.equal(ran.statusCode, 200, JSON.stringify(ran.body))
    assert.ok(['succeeded', 'partial'].includes((await h.context.storage.get(checkpointKey(applyJobId))).status))
    const enabled = await enablePilot(h, WORKBENCH_ADMIN)
    assert.equal(enabled.statusCode, 200, JSON.stringify(enabled.body))
    assert.equal(enabled.body.data.enabled, true)
  } finally { h.restore() }
  // FAIL CLOSED: a job store that cannot list its keys cannot prove there is no open job.
  const h2 = mountReady()
  try {
    delete h2.context.storage.list
    const res = await getPilot(h2, WORKBENCH_ADMIN)
    assert.deepEqual(res.body.data.readiness.failing, ['no_open_large_job'])
  } finally { h2.restore() }
  // THE WINDOW: a job that lands a chunk AFTER readiness scanned and BEFORE the enable's lease (simulated by a
  // later readiness probe storing a paused job for this sheet). The scan under the lease refuses: 409 NOT_READY
  // `no_open_large_job`, nothing stamped, marked or audited.
  const h3 = mountReady()
  try {
    const probeOriginal = h3.projectTargetStore.probeTableReadable
    let landed = false
    h3.projectTargetStore.probeTableReadable = async (table) => {
      if (!landed) {
        landed = true
        await h3.context.storage.set(checkpointKey('job-peh-window'), { jobId: 'job-peh-window', ...JOB_SCOPE, status: 'paused', target: { sheetId: h3.sheetId, objectId: h3.objectId, fieldIdMap: {} } })
      }
      return probeOriginal.call(h3.projectTargetStore, table)
    }
    const raced = await enablePilot(h3, WORKBENCH_ADMIN)
    assert.equal(landed, true, 'calibration: the job landed after the readiness scan')
    assert.equal(raced.statusCode, 409, JSON.stringify(raced.body))
    assert.equal(raced.body.error.code, PILOT_ERROR_CODES.NOT_READY)
    assert.deepEqual(details(raced).failing, ['no_open_large_job'])
    assert.equal(h3.provisioning.gridExportClosureCalls.length, 0, 'no stamp')
    assert.equal(h3.registryRows()[0].pilot_enabled_at, undefined, 'not marked')
    assert.deepEqual(h3.auditAppends, [])
    assert.equal((await h3.projectWriteLock.readState(swlLockLib.sheetWriteScopeKey(h3.sheetId))).leaseHeld, false, 'the lease was released')
  } finally { h3.restore() }
})

/** Rows on the harness host (physical keys, the project's own number) — what the project-scoped read answers. */
async function seedSheetRows(h, rows) {
  const physical = (fieldId) => h.provisioning.getFieldId(h.staging, h.objectId, fieldId)
  for (const row of rows) {
    const data = Object.fromEntries(Object.entries({ projectNo: PROJECT, active: true, ...row }).map(([key, value]) => [physical(key), value]))
    await h.records.createRecord({ sheetId: h.sheetId, data })
  }
}

test('P-15 (F-5 / O-6) no_two_copy_component: a sheet holding one component as an active root AND an active nested copy is refused with nothing done; the same sheet with the copy inactive enables', async () => {
  const doubled = mountReady()
  try {
    await seedSheetRows(doubled, [
      { idempotencyKey: 'syn-k-root-c1', componentSourceId: 'SYN-PEH-C1', parentSourceId: null },
      { idempotencyKey: 'syn-k-root-p1', componentSourceId: 'SYN-PEH-P1', parentSourceId: null },
      { idempotencyKey: 'syn-k-p1-c1', componentSourceId: 'SYN-PEH-C1', parentSourceId: 'SYN-PEH-P1' },
    ])
    const seen = await getPilot(doubled, WORKBENCH_ADMIN)
    assert.deepEqual(seen.body.data.readiness.failing, ['no_two_copy_component'])
    const refused = await enablePilot(doubled, WORKBENCH_ADMIN)
    assert.equal(refused.statusCode, 409, JSON.stringify(refused.body))
    assert.deepEqual(details(refused).failing, ['no_two_copy_component'])
    assert.ok(!JSON.stringify(refused.body).includes('SYN-PEH'), 'values-free: no component id in the refusal')
    assert.equal(doubled.provisioning.gridExportClosureCalls.length, 0)
    assert.deepEqual(doubled.auditAppends, [])
    assert.equal(doubled.registryRows()[0].pilot_enabled_at, undefined)
  } finally { doubled.restore() }
  const repaired = mountReady()
  try {
    await seedSheetRows(repaired, [
      { idempotencyKey: 'syn-k-root-c1', componentSourceId: 'SYN-PEH-C1', parentSourceId: null },
      { idempotencyKey: 'syn-k-root-p1', componentSourceId: 'SYN-PEH-P1', parentSourceId: null },
      { idempotencyKey: 'syn-k-p1-c1', componentSourceId: 'SYN-PEH-C1', parentSourceId: 'SYN-PEH-P1', active: false },
    ])
    const res = await enablePilot(repaired, WORKBENCH_ADMIN)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.enabled, true)
  } finally { repaired.restore() }
})

test('P-16 (F-5 / O-8) pack_columns_installed: an action declaring an ext_ column enables only once that column is listed live by the pack ledger AND present on the project sheet; no declaration at all refuses', async () => {
  const EXT = 'ext_synPehPack'
  const h = mountReady({
    extensionFieldIds: [EXT],
    configExtras: { stockPreparationPilot: { specReadPlanSlot: SPEC_READ_PLAN_SLOT_NOT_APPLICABLE } },
  })
  try {
    const { objectId } = h
    const failing = async () => (await getPilot(h, WORKBENCH_ADMIN)).body.data.readiness.failing
    assert.deepEqual(await failing(), ['pack_columns_installed'], 'declared, nothing installed')
    // The ledger lists it (a live install on THIS sheet), the host does not have the column (yet / any more).
    h.db.rowsOf(projectSheet.PACK_INSTALL_TABLE).push({
      id: 'seed-peh-pack', tenant_id: TENANT, workspace_id: null, project_id: h.staging, object_id: objectId, pack_id: 'syn_peh_pack', pack_version: '1',
      mode: 'install', status: 'installed', installed_fields_json: [{ fieldId: EXT }], summary_json: {}, warnings_json: [], last_install_at: new Date('2026-10-23T00:00:00Z'),
    })
    assert.deepEqual(await failing(), ['pack_columns_installed'], 'in the ledger, not on the sheet')
    // The column on the project sheet: installed and declared — the check passes and the enable lands.
    h.provisioning.objects.get(`${h.staging}/${objectId}`).fields.set(EXT, { name: 'syn pack column', type: 'string', property: { stockPreparation: { ownership: 'plm_system' } } })
    assert.deepEqual(await failing(), [])
    const res = await enablePilot(h, WORKBENCH_ADMIN)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  } finally { h.restore() }
  // Neither a declared column nor the not-applicable declaration: never guessed.
  const undeclared = mountReady({ configExtras: { stockPreparationPilot: { specReadPlanSlot: SPEC_READ_PLAN_SLOT_NOT_APPLICABLE } } })
  try {
    assert.deepEqual((await getPilot(undeclared, WORKBENCH_ADMIN)).body.data.readiness.failing, ['pack_columns_installed'])
  } finally { undeclared.restore() }
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
    await seedPlannedExpansionJob(off, { jobId: 'job-pb-off-sheet', target: { sheetId, objectId, fieldIdMap: {} }, projectNo: OTHER_PROJECT, deliberateTargetSplit: true })
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

// ── PR-N4: spec_read_plan_slot under the online read-plan switch (S1 N4) ───────────────────────────────
// The readiness dep `specSlotReadPlans` names the deployment plan and, with MULTITABLE_STOCK_PREP_ONLINE_READ_PLANS_ENABLED
// 'true', the effective plan of the hint-less lanes; every other check keeps the deployment action. The deployment
// plan is set through configExtras.stockPreparationTableActions; a spy ledger is patched onto the captured services
// (read at call time) with its pointer at the tenant scope only. Switch-ON calls carry the verified claim.

const N4_SYSTEM = 'plm_sql_source_synthetic' // the harness deployment's own source

function n4ReadPlan({ spec }) {
  return {
    id: 'plm.stock-preparation.bom-read.user-draft.v1', sourceKind: 'data-source:sql-readonly', matchField: 'project', maxReadCount: 100,
    pathExAttr: { object: 'SYN_PB_PathLink', matchField: 'project', pathIdField: 'path' },
    pathInfo: { object: 'SYN_PB_Path', idField: 'id' },
    orderHead: { object: 'SYN_PB_Order', idField: 'id', pathIdField: 'path' },
    orderDetail: { object: 'SYN_PB_OrderLine', orderIdField: 'order', componentIdField: 'part', quantityField: 'qty' },
    part: { object: 'SYN_PB_Part', idField: 'id', codeField: 'code', nameField: 'name', ...(spec ? { specField: 'spec' } : {}) },
    bomHead: { object: 'SYN_PB_Bom', parentPartField: 'part', bomIdField: 'id' },
    bomDetail: { object: 'SYN_PB_BomLine', bomParentField: 'bom', componentIdField: 'part', quantityField: 'qty' },
  }
}

// The ledger's canonical JSON + sha256 content key (stock-preparation-read-plan-store.cjs).
function n4CanonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(n4CanonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${n4CanonicalJson(value[key])}`).join(',')}}`
}

// The runtime read's answer for one approved, activated online plan at (TENANT, workspace null).
function n4OnlinePlan({ spec }) {
  const config = validateStockPreparationReadPlanConfig({ schemaVersion: 1, actionId: ACTION_ID, systemId: N4_SYSTEM, readPlan: n4ReadPlan({ spec }) })
  const contentKey = crypto.createHash('sha256').update(n4CanonicalJson(config)).digest('hex')
  const version = { id: 'rpv_pb_1', tenantId: TENANT, workspaceId: null, actionId: ACTION_ID, systemId: N4_SYSTEM, schemaVersion: 1, version: 1, status: 'approved', config, contentKey }
  const activation = { id: 'rpa_pb_1', tenantId: TENANT, workspaceId: null, actionId: ACTION_ID, systemId: N4_SYSTEM, versionId: version.id, contentKey, generation: 1, status: 'active', validationId: 'rpval_pb_1' }
  const sourceValidation = { connectionId: 'conn_pb_synthetic', connectionRevision: '22222222-2222-4222-8222-222222222222', bindingRevision: '11111111-1111-4111-8111-111111111111' }
  return { activation, version, sourceValidation }
}

// The spy ledger: every runtime read counted; 'active' answers the plan at workspace null, 'disabled' refuses as the
// real store does (409 READ_PLAN_ACTIVATION_DISABLED).
function n4SpyReadPlanStore(plan, mode) {
  const spy = {
    calls: [],
    async getActivation() { return null },
    async getActiveForRuntime(input) {
      spy.calls.push({ ...input })
      if (input.workspaceId !== null) return null
      if (mode === 'disabled') throw new StockPreparationReadPlanStoreError(409, 'READ_PLAN_ACTIVATION_DISABLED')
      return { activation: { ...plan.activation }, version: { ...plan.version, config: JSON.parse(JSON.stringify(plan.version.config)) }, sourceValidation: { ...plan.sourceValidation } }
    },
  }
  return spy
}

function withOnlineSwitch(online) {
  const previous = process.env[ONLINE_READ_PLANS_ENABLED_ENV]
  if (online) process.env[ONLINE_READ_PLANS_ENABLED_ENV] = 'true'
  else delete process.env[ONLINE_READ_PLANS_ENABLED_ENV]
  return () => {
    if (previous === undefined) delete process.env[ONLINE_READ_PLANS_ENABLED_ENV]
    else process.env[ONLINE_READ_PLANS_ENABLED_ENV] = previous
  }
}

/**
 * A prepared mount (every other check passes) whose deployment plan declares the 规格 column or not, the customer
 * pack declared not applicable, the 规格 slot declared not applicable only when asked, the switch set or unset, and
 * the spy ledger answering an online plan that declares the column or not.
 */
function mountN4({ online = true, mode = 'active', deploymentSpec, onlineSpec, specNotApplicable = false, sourceBindingStore = null }) {
  const restoreSwitch = withOnlineSwitch(online)
  let ready
  try {
    ready = mountReady({
      ...(sourceBindingStore ? { sourceBindingStore } : {}),
      configExtras: {
        stockPreparationPilot: { customerPack: CUSTOMER_PACK_NOT_APPLICABLE, ...(specNotApplicable ? { specReadPlanSlot: SPEC_READ_PLAN_SLOT_NOT_APPLICABLE } : {}) },
        stockPreparationTableActions: [{
          actionId: ACTION_ID,
          source: { externalSystemId: N4_SYSTEM, kind: 'data-source:sql-readonly', readPlan: n4ReadPlan({ spec: deploymentSpec }) },
          target: { sheetId: 'sheet_env_synthetic', objectId: 'plm_stock_preparation_sandbox_synthetic_env', fieldIdMap: {} },
        }],
      },
    })
  } catch (error) {
    restoreSwitch()
    throw error
  }
  const spy = n4SpyReadPlanStore(n4OnlinePlan({ spec: onlineSpec }), mode)
  ready.services.stockPreparationReadPlanStore = spy
  const restoreReady = ready.restore
  return { ...ready, spy, restore: () => { try { restoreReady() } finally { restoreSwitch() } } }
}

const getPilotClaimed = (h) => projectSheet.call(h.routes, 'GET', PILOT_PATH, { user: WORKBENCH_ADMIN, params: { projectNo: PROJECT }, query: {}, authenticatedTenantId: TENANT })
const enablePilotClaimed = (h) => projectSheet.call(h.routes, 'POST', PILOT_PATH, { user: WORKBENCH_ADMIN, params: { projectNo: PROJECT }, body: confirm(PROJECT), authenticatedTenantId: TENANT })

/** ENABLE refused 409 NOT_READY naming exactly `failing`: nothing bumped, no lease, no stamp, no mark, no audit row. */
async function assertEnableRefusedNothingDone(h, failing, label) {
  const scope = swlLockLib.sheetWriteScopeKey(h.sheetId)
  const before = await h.projectWriteLock.readState(scope)
  const res = await enablePilotClaimed(h)
  assert.equal(res.statusCode, 409, `${label}: ${JSON.stringify(res.body)}`)
  assert.equal(res.body.error.code, PILOT_ERROR_CODES.NOT_READY, label)
  assert.deepEqual(details(res), { version: PILOT_READINESS_VERSION, failing, partial: false }, label)
  assert.deepEqual(await h.projectWriteLock.readState(scope), before, `${label}: the generation did not move and no lease was taken`)
  assert.equal(h.provisioning.gridExportClosureCalls.length, 0, `${label}: no stamp`)
  assert.ok(!h.db.calls.some((call) => /^(updateRow|transaction)/.test(call)), `${label}: no registry write`)
  assert.equal(h.registryRows()[0].pilot_enabled_at, undefined, `${label}: no mark`)
  assert.deepEqual(h.auditAppends, [], `${label}: no audit row`)
}

test('PR-N4a switch ON, an active pointer, nothing declared not applicable: the DEPLOYMENT plan declares the 规格 column and the ONLINE plan does not ⇒ spec_read_plan_slot fails on GET; ENABLE is 409 NOT_READY with it — nothing bumped, stamped, marked or audited', async () => {
  const h = mountN4({ deploymentSpec: true, onlineSpec: false })
  try {
    const read = await getPilotClaimed(h)
    assert.equal(read.statusCode, 200, JSON.stringify(read.body))
    assert.deepEqual(read.body.data.readiness.failing, ['spec_read_plan_slot'])
    assert.deepEqual(read.body.data.may, { enable: false })
    await assertEnableRefusedNothingDone(h, ['spec_read_plan_slot'], 'deployment only')
    assert.deepEqual(h.spy.calls.map((call) => call.workspaceId), [null, null], 'GET and ENABLE each read the tenant-scope pointer once')
  } finally { h.restore() }
})

test('PR-N4b switch ON: the deployment plan LACKS the 规格 column and the online plan declares it ⇒ still failing (today\'s answer: both plans must declare it)', async () => {
  const h = mountN4({ deploymentSpec: false, onlineSpec: true })
  try {
    const read = await getPilotClaimed(h)
    assert.equal(read.statusCode, 200, JSON.stringify(read.body))
    assert.deepEqual(read.body.data.readiness.failing, ['spec_read_plan_slot'])
    await assertEnableRefusedNothingDone(h, ['spec_read_plan_slot'], 'online only')
  } finally { h.restore() }
})

test('PR-N4c switch ON: BOTH plans declare the 规格 column ⇒ spec_read_plan_slot ok, the project may be enabled', async () => {
  const h = mountN4({ deploymentSpec: true, onlineSpec: true })
  try {
    const read = await getPilotClaimed(h)
    assert.equal(read.statusCode, 200, JSON.stringify(read.body))
    assert.deepEqual(read.body.data.readiness.failing, [])
    assert.equal(read.body.data.readiness.checks.find((check) => check.id === 'spec_read_plan_slot').ok, true)
    assert.deepEqual(read.body.data.may, { enable: true })
    const enabled = await enablePilotClaimed(h)
    assert.equal(enabled.statusCode, 200, JSON.stringify(enabled.body))
    assert.equal(enabled.body.data.enabled, true)
    assert.equal(h.spy.calls.length, 2)
  } finally { h.restore() }
})

test('PR-N4d switch ON, a DISABLED pointer: the effective plan cannot be resolved, so spec_read_plan_slot is not ok (a resolver refusal never passes); ENABLE is refused NOT_READY with nothing done', async () => {
  const h = mountN4({ mode: 'disabled', deploymentSpec: true, onlineSpec: true })
  try {
    const read = await getPilotClaimed(h)
    assert.equal(read.statusCode, 200, JSON.stringify(read.body))
    assert.deepEqual(read.body.data.readiness.failing, ['spec_read_plan_slot'])
    assert.ok(!JSON.stringify(read.body).includes('READ_PLAN_'), 'the readiness answer stays values-free: an id and a boolean')
    await assertEnableRefusedNothingDone(h, ['spec_read_plan_slot'], 'disabled pointer')
    assert.equal(h.spy.calls.length, 2)
  } finally { h.restore() }
})

test('PR-N4e switch UNSET: the P-04 / P-05 answers as today — the readiness lists the same failing ids and ENABLE refuses with them — and neither GET nor ENABLE reads an activation pointer', async () => {
  const restoreSwitch = withOnlineSwitch(false)
  const h = mount()
  try {
    const spy = n4SpyReadPlanStore(n4OnlinePlan({ spec: false }), 'active')
    h.services.stockPreparationReadPlanStore = spy
    const { sheetId } = h.seedRegistryRow(PROJECT)
    const expected = ['plm_column_lock', 'contract_option_sets', 'export_closure_port', 'spec_read_plan_slot', 'pack_columns_installed', 'no_generic_writer_names_sheet', 'continuation_support_version']
    const read = await getPilot(h, WORKBENCH_ADMIN)
    assert.equal(read.statusCode, 200, JSON.stringify(read.body))
    assert.deepEqual(read.body.data.readiness.failing, expected)
    const scope = swlLockLib.sheetWriteScopeKey(sheetId)
    const before = await h.projectWriteLock.readState(scope)
    const res = await enablePilot(h, WORKBENCH_ADMIN)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.deepEqual(details(res), { version: PILOT_READINESS_VERSION, failing: expected, partial: false })
    assert.deepEqual(await h.projectWriteLock.readState(scope), before)
    assert.deepEqual(h.auditAppends, [])
    assert.deepEqual(spy.calls, [], 'switch unset: no pointer read on GET or ENABLE')
  } finally {
    try { h.restore() } finally { restoreSwitch() }
  }
})

test('PR-N4f switch ON, the server declares the 规格 slot NOT APPLICABLE: ok without asking for any plan — the dep is never called, no pointer read (and the project enables)', async () => {
  const h = mountN4({ specNotApplicable: true, deploymentSpec: false, onlineSpec: false })
  try {
    const read = await getPilotClaimed(h)
    assert.equal(read.statusCode, 200, JSON.stringify(read.body))
    assert.deepEqual(read.body.data.readiness.failing, [])
    const enabled = await enablePilotClaimed(h)
    assert.equal(enabled.statusCode, 200, JSON.stringify(enabled.body))
    assert.deepEqual(h.spy.calls, [], 'not applicable answers first: no plan, no pointer read')
  } finally { h.restore() }
})

test('PR-N4g (S1b) switch ON, an active pointer, both plans declaring the 规格 column, but the binding set names two systems (a tenant row and a workspace row of another source): the effective resolver refuses before any pointer read, so spec_read_plan_slot fails on GET and ENABLE is 409 NOT_READY with nothing done', async () => {
  const bindings = require('./support/stock-preparation-refresh-governance-wiring.cjs').createSourceBindingStoreFake()
  bindings.seed({ tenantId: TENANT, actionId: ACTION_ID, workspaceId: null, externalSystemId: N4_SYSTEM })
  bindings.seed({ tenantId: TENANT, actionId: ACTION_ID, workspaceId: 'ws_pb_hint', externalSystemId: 'other_source_synthetic' })
  const h = mountN4({ deploymentSpec: true, onlineSpec: true, sourceBindingStore: bindings })
  try {
    const read = await getPilotClaimed(h)
    assert.equal(read.statusCode, 200, JSON.stringify(read.body))
    assert.deepEqual(read.body.data.readiness.failing, ['spec_read_plan_slot'])
    assert.ok(!JSON.stringify(read.body).includes('READ_PLAN_'), 'the readiness answer stays values-free: an id and a boolean')
    await assertEnableRefusedNothingDone(h, ['spec_read_plan_slot'], 'split binding set')
    assert.deepEqual(h.spy.calls, [], 'refused before any pointer read')
  } finally { h.restore() }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pilot-routes.test.cjs', tests, { passLine: '✓ stock-preparation-pilot-routes' })
