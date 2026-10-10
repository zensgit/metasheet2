'use strict'

// 一个项目一张备料表 — S4 归档与恢复 (ADR adr-stock-prep-project-sheets-20261008 §6; register R-38).
// The real route stack over the shared project-sheet substrate (support/stock-preparation-project-
// sheet-harness.cjs: the REAL registry store over a memory db, a host whose provisioning records every
// call), plus a ledger substrate (fixtures/stock-preparation-multitable-fakes.cjs) for the confirm row.
//
//   A-01 SWITCH OFF: archive / restore answer 404 STOCK_PREPARATION_PROJECT_SHEETS_DISABLED with ZERO
//        IO — no registry statement, no host call, no audit row — for every tier the gate admits,
//        even with a registered row; a caller below PULL is refused by the gate FIRST.
//   A-02 THE TIERS (Q2: 归档 / 恢复归拉取人员): the floor operator (read+operate), a read-only caller,
//        pull without operate and anonymous are refused at the gate with zero IO and the row
//        unchanged; the 拉取人员, stock-prep:admin and the platform admin each archive AND restore.
//   A-03 THE TYPED CONFIRMATION: a missing, different, case-folded, prefix, or non-string
//        `confirmProjectNo` is 400 STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH; an extra body key or a
//        malformed path number is 400 REQUEST_INVALID — all before ANY IO, values-free (the refusal
//        names the field and never echoes either number).
//   A-04 ARCHIVE DOES ONE THING: the registry row → archived (archived_at / archived_by), ONE audit row
//        `project_target_archive` — and nothing else: no host call at all (no provisioning, no grant,
//        no delete), no records call; the sheet object and its columns are exactly as they were; GET
//        target still names the SAME sheet, `may.restore` for a puller only.
//   A-05 TYPED 409s: archiving an archived project is ALREADY_ARCHIVED, restoring an active one is
//        NOT_ARCHIVED, an unregistered (or another tenant's) project is ABSENT — no audit row, no row
//        moved.
//   A-06 RESTORE: archived → active, ONE audit row `project_target_restore`, the SAME sheet — and the
//        pull is usable again: the dry run that answered 409 ARCHIVED is 200 ready.
//   A-07 THE 200 CAP COUNTS ARCHIVED ROWS: at 200 (archived included) a new create is 409 LIMIT;
//        archiving frees nothing; restoring at the cap is NOT refused (the row was already counted).
//   A-08 THE §6 ROUTE TABLE, row by row, on one archived project: create, dry-run, apply, reconcile,
//        mvp-persist, 大 BOM expansion-start / plan / apply-start / apply-run, conflict-policies save
//        / delete, 结转 carry/confirm and 交接推进 each refuse 409 STOCK_PREPARATION_PROJECT_ARCHIVED
//        with no write (no record written, no audit row, no cursor move, no apply-job step, no sheet
//        provisioned); and 看板, 导出, 交接状态, conflict-policies list and GET target answer EXACTLY
//        what they answered before the archive.
//   A-09 confirm 裁决 (the §6 row's first member): with the switch on, confirming a decision whose
//        ledger row names an archived project is 409 ARCHIVED and the ledger is NOT patched; 录入值回读
//        still answers; restore → the same confirm succeeds; switch off → the registry is never
//        consulted and the confirm is unchanged; a registry read that fails refuses (fail-closed).
//   A-10 (fix round 1) THE CREATE-REPLAY RACE, forced on the harness's real per-key mutex: (a) an
//        archive that commits right after the create route's unlocked read makes the replay refuse
//        409 ARCHIVED with no grant, no pack write and no audit row of its own; (b) an archive that
//        arrives WHILE the replay heals waits for the heal (the lock is held across it) and then
//        archives.
//
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const projectSheet = require(path.join(__dirname, 'support', 'stock-preparation-project-sheet-harness.cjs'))
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  STOCK_PREP_ADMIN,
  STOCK_PREP_OPERATE,
  STOCK_PREP_PULL,
  STOCK_PREP_READ,
} = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID, createStockPreparationTableActionRegistry } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { MAX_PROJECT_TARGETS_PER_TENANT, PROJECT_SHEETS_ENABLED_ENV, resolveProjectTargetForAction } = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const { createStockPreparationProjectTargetStore } = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
const largeBomJobs = require(path.join(LIB, 'stock-preparation-large-bom-jobs.cjs'))
const {
  OBJECT_ID: LEDGER_OBJECT_ID,
  FIRST_CUT_CONFLICT_TYPE,
  STATUSES,
  RESOLUTION_ACTIONS,
} = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalFieldId,
  physicalRow,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const TENANT = 'tenant-s4-archive'
const OTHER_TENANT = 'tenant-s4-foreign'
const PROJECT = 'PRJ-S4-A1'
const OTHER_PROJECT = 'PRJ-S4-A2'

const ARCHIVE_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/archive'
const RESTORE_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/restore'
const TARGET_PATH = '/api/integration/stock-preparation/projects/:projectNo/target'
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const APPLY_PATH = '/api/integration/table-actions/:actionId/apply'
const RECONCILE_PATH = '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile'
const MVP_PERSIST_PATH = '/api/integration/table-actions/:actionId/mvp-persist'
const JOBS_PATH = '/api/integration/table-actions/:actionId/large-bom/expansion-jobs'
const PLAN_PATH = `${JOBS_PATH}/:jobId/plan`
const APPLY_START_PATH = `${JOBS_PATH}/:jobId/apply-jobs`
const APPLY_RUN_PATH = `${JOBS_PATH}/:jobId/apply-jobs/:applyJobId/run`
const POLICIES_PATH = '/api/integration/table-actions/:actionId/conflict-policies'
const CARRY_PATH = '/api/integration/stock-preparation/carry/confirm'
const HANDOFF_PATH = '/api/integration/stock-preparation/handoff'
const HANDOFF_ADVANCE_PATH = '/api/integration/stock-preparation/handoff/advance'
const BOARD_PATH = '/api/integration/stock-preparation/projects/:projectNo/board'
const EXPORT_PATH = '/api/integration/stock-preparation/prep-lines/export'
const CONFIRM_PATH = '/api/integration/stock-preparation/confirmation-decisions/confirm'
const VALUE_ENTRY_PATH = '/api/integration/stock-preparation/confirmation-decisions/value-entry'
const ACTION_ID = PLM_STOCK_PREPARATION_ACTION_ID
const JOB_SCOPE = Object.freeze({ tenantId: TENANT, workspaceId: 'workspace-default' })
const MVP_PERSIST_ENV = 'MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED'

const FLOOR = Object.freeze({ id: 'u_s4_floor', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const READ_ONLY = Object.freeze({ id: 'u_s4_read', tenantId: TENANT, permissions: [STOCK_PREP_READ] })
const PULL_NO_OPERATE = Object.freeze({ id: 'u_s4_pull_no_op', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_PULL] })
const PULLER = Object.freeze({ id: 'u_s4_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const WORKBENCH_ADMIN = Object.freeze({ id: 'u_s4_wb', tenantId: TENANT, permissions: [STOCK_PREP_ADMIN] })
const PLATFORM_ADMIN = Object.freeze({ id: 'u_s4_admin', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] })

const confirm = (projectNo = PROJECT) => ({ confirmProjectNo: projectNo })
const archive = (h, user, projectNo = PROJECT, body = confirm(projectNo)) => projectSheet.call(h.routes, 'POST', ARCHIVE_PATH, { user, params: { projectNo }, body })
const restore = (h, user, projectNo = PROJECT, body = confirm(projectNo)) => projectSheet.call(h.routes, 'POST', RESTORE_PATH, { user, params: { projectNo }, body })
const getTarget = (h, user, projectNo = PROJECT) => projectSheet.call(h.routes, 'GET', TARGET_PATH, { user, params: { projectNo }, query: { tenantId: TENANT } })
const dryRun = (h, user = PULLER, projectNo = PROJECT) => projectSheet.call(h.routes, 'POST', DRY_RUN_PATH, { user, params: { actionId: ACTION_ID }, body: { parameters: { projectNo } }, query: { tenantId: TENANT } })

function mount(options = {}) {
  return projectSheet.mountProjectSheetRoutes({
    tenantId: TENANT, projectNo: PROJECT, switchOn: true, ...options,
    serviceExtras: {
      // This synthetic binding has no activation pointer, not a missing read-plan runtime.
      stockPreparationReadPlanStore: { async getActiveForRuntime() { return null } },
      ...options.serviceExtras,
    },
  })
}

function snapshotObject(h, objectId) {
  const object = h.provisioning.objects.get(`${h.staging}/${objectId}`)
  assert.ok(object, 'the project sheet object exists on the host')
  return JSON.stringify({ name: object.name, baseId: object.baseId, fields: [...object.fields.entries()] })
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('A-01 switch OFF: archive / restore are 404 DISABLED with zero IO for every admitted tier; below PULL the gate refuses first', async () => {
  const h = mount({ switchOn: false })
  try {
    h.seedRegistryRow(PROJECT)
    for (const user of [PULLER, WORKBENCH_ADMIN, PLATFORM_ADMIN]) {
      for (const [label, run] of [['archive', archive], ['restore', restore]]) {
        const res = await run(h, user)
        assert.equal(res.statusCode, 404, `${label} as ${user.id}: ${JSON.stringify(res.body)}`)
        assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED')
      }
    }
    for (const user of [FLOOR, READ_ONLY, PULL_NO_OPERATE]) {
      for (const run of [archive, restore]) {
        const res = await run(h, user)
        assert.equal(res.statusCode, 403, `${user.id}: ${JSON.stringify(res.body)}`)
        assert.equal(res.body.error.code, 'FORBIDDEN')
      }
    }
    assert.deepEqual(h.db.calls, [], 'no registry statement while the switch is off')
    assert.deepEqual(h.provisioning.calls, [], 'no host call')
    assert.deepEqual(h.auditAppends, [], 'no audit row')
    assert.equal(h.registryRows()[0].status, 'active', 'the registered row did not move')
  } finally { h.restore() }
})

test('A-02 tiers: floor / read-only / pull-without-operate / anonymous refused with zero IO; puller, stock-prep:admin and platform admin archive and restore', async () => {
  for (const user of [undefined, FLOOR, READ_ONLY, PULL_NO_OPERATE]) {
    const h = mount()
    try {
      h.seedRegistryRow(PROJECT)
      const refusedArchive = await archive(h, user)
      assert.equal(refusedArchive.statusCode, user ? 403 : 401, `archive as ${user ? user.id : 'anonymous'}: ${JSON.stringify(refusedArchive.body)}`)
      h.registryRows()[0].status = 'archived'
      h.registryRows()[0].archived_at = new Date('2026-10-09T00:00:00Z')
      const refusedRestore = await restore(h, user)
      assert.equal(refusedRestore.statusCode, user ? 403 : 401, `restore as ${user ? user.id : 'anonymous'}`)
      assert.deepEqual(h.db.calls, [], 'a refused caller costs no registry statement')
      assert.deepEqual(h.provisioning.calls, [], 'a refused caller costs no host call')
      assert.deepEqual(h.auditAppends, [], 'a refused caller writes no audit row')
      assert.equal(h.registryRows()[0].status, 'archived', 'the row is exactly as the test left it')
    } finally { h.restore() }
  }
  for (const user of [PULLER, WORKBENCH_ADMIN, PLATFORM_ADMIN]) {
    const h = mount()
    try {
      const { sheetId } = h.seedRegistryRow(PROJECT)
      const archived = await archive(h, user)
      assert.equal(archived.statusCode, 200, `archive as ${user.id}: ${JSON.stringify(archived.body)}`)
      assert.equal(archived.body.data.status, 'archived')
      const restored = await restore(h, user)
      assert.equal(restored.statusCode, 200, `restore as ${user.id}: ${JSON.stringify(restored.body)}`)
      assert.equal(restored.body.data.status, 'active')
      assert.equal(restored.body.data.sheetId, sheetId)
      assert.deepEqual(h.auditAppends.map((entry) => [entry.action, entry.actor]), [
        ['project_target_archive', user.id],
        ['project_target_restore', user.id],
      ])
    } finally { h.restore() }
  }
})

test('A-03 the typed confirmation: mismatch / missing / folded / prefix / non-string → 400 CONFIRM_MISMATCH; extra key or bad path → 400 REQUEST_INVALID; all before any IO, values-free', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    h.seedRegistryRow(OTHER_PROJECT)
    for (const [label, run] of [['archive', archive], ['restore', restore]]) {
      for (const body of [{}, { confirmProjectNo: OTHER_PROJECT }, { confirmProjectNo: PROJECT.toLowerCase() }, { confirmProjectNo: PROJECT.slice(0, -1) }, { confirmProjectNo: `${PROJECT}-X` }, { confirmProjectNo: 7 }, { confirmProjectNo: '' }, { confirmProjectNo: null }]) {
        const res = await run(h, PULLER, PROJECT, body)
        assert.equal(res.statusCode, 400, `${label} ${JSON.stringify(body)}: ${JSON.stringify(res.body)}`)
        assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH')
        assert.deepEqual({ ...res.body.error.details }, { field: 'confirmProjectNo' })
        const text = JSON.stringify(res.body)
        assert.ok(!text.includes(PROJECT) && !text.includes(OTHER_PROJECT) && !text.includes(PROJECT.toLowerCase()), `${label}: the refusal echoes neither number`)
      }
      const extra = await run(h, PULLER, PROJECT, { confirmProjectNo: PROJECT, tenantId: TENANT })
      assert.equal(extra.statusCode, 400)
      assert.equal(extra.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_REQUEST_INVALID')
      for (const bad of ['a b', '-leading', 'x'.repeat(81)]) {
        const res = await run(h, PULLER, bad, { confirmProjectNo: bad })
        assert.equal(res.statusCode, 400, `${label} path ${JSON.stringify(bad)}`)
        assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_REQUEST_INVALID')
      }
    }
    assert.deepEqual(h.db.calls, [], 'no registry statement for a refused confirmation')
    assert.deepEqual(h.provisioning.calls, [])
    assert.deepEqual(h.auditAppends, [])
    assert.deepEqual(h.registryRows().map((row) => row.status), ['active', 'active'])
    // The same trim the path value gets: surrounding whitespace is not a mismatch.
    const trimmed = await archive(h, PULLER, PROJECT, { confirmProjectNo: ` ${PROJECT} ` })
    assert.equal(trimmed.statusCode, 200, JSON.stringify(trimmed.body))
    assert.deepEqual(h.registryRows().map((row) => row.status), ['archived', 'active'], 'only the confirmed project moved')
  } finally { h.restore() }
})

test('A-04 archive changes the registry row and writes one audit row — no host call, no records call, the sheet and its grants untouched', async () => {
  const h = mount({ grantRoleIds: ['stock-prep_frontline'] })
  try {
    const { sheetId, objectId } = h.seedRegistryRow(PROJECT)
    const sheetBefore = snapshotObject(h, objectId)
    const res = await archive(h, PULLER)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual({ ...res.body.data, archivedAt: typeof res.body.data.archivedAt }, {
      projectNo: PROJECT, status: 'archived', sheetId, archivedAt: 'string', restoredAt: null,
      may: { create: false, archive: false, restore: true },
    })
    const row = h.registryRows()[0]
    assert.equal(row.status, 'archived')
    assert.equal(row.archived_by, PULLER.id)
    assert.ok(row.archived_at instanceof Date, 'archived_at stamped (087 CHECK: archived ⇔ archived_at)')
    assert.equal(row.sheet_id, sheetId, 'the row still names the same sheet')
    assert.deepEqual(h.auditAppends, [{
      tenantId: TENANT, projectId: PROJECT, action: 'project_target_archive', subjectId: sheetId,
      mode: 'archived', actor: PULLER.id, detail: { fromStatus: 'active', toStatus: 'archived' },
    }])
    // NOTHING on the host: no provisioning verb, no grant (G1 is configured and still not called), no
    // delete — and the sheet object, columns included, is byte-for-byte what it was.
    assert.deepEqual(h.provisioning.calls, [], 'archive makes no host call at all')
    assert.deepEqual(h.provisioning.grantCalls, [], 'grants untouched')
    assert.deepEqual(h.records.calls, [], 'no records read or write')
    assert.equal(snapshotObject(h, objectId), sheetBefore, 'the sheet is exactly as it was')
    // GET target still names the same sheet; the floor can still open it, only a puller may restore.
    const asPuller = await getTarget(h, PULLER)
    assert.equal(asPuller.body.data.status, 'archived')
    assert.equal(asPuller.body.data.sheetId, sheetId)
    assert.deepEqual(asPuller.body.data.may, { create: false, archive: false, restore: true })
    const asFloor = await getTarget(h, FLOOR)
    assert.equal(asFloor.body.data.sheetId, sheetId)
    assert.equal(typeof asFloor.body.data.viewId, 'string', 'the floor keeps the deep link')
    assert.deepEqual(asFloor.body.data.may, { create: false, archive: false, restore: false })
  } finally { h.restore() }
})

test('A-05 typed 409s: archive of archived, restore of active, unregistered and foreign-tenant projects — no audit row, nothing moved', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    h.seedRegistryRow(OTHER_PROJECT, { tenant: OTHER_TENANT })
    const notArchived = await restore(h, PULLER)
    assert.equal(notArchived.statusCode, 409, JSON.stringify(notArchived.body))
    assert.equal(notArchived.body.error.code, 'STOCK_PREPARATION_PROJECT_NOT_ARCHIVED')
    assert.equal((await archive(h, PULLER)).statusCode, 200)
    const again = await archive(h, PULLER)
    assert.equal(again.statusCode, 409)
    assert.equal(again.body.error.code, 'STOCK_PREPARATION_PROJECT_ALREADY_ARCHIVED')
    for (const run of [archive, restore]) {
      const absent = await run(h, PULLER, 'PRJ-S4-NOPE')
      assert.equal(absent.statusCode, 409)
      assert.equal(absent.body.error.code, 'STOCK_PREPARATION_PROJECT_ABSENT')
      // Another tenant's project with the same shape of number is ABSENT here, and untouched.
      const foreign = await run(h, PULLER, OTHER_PROJECT)
      assert.equal(foreign.statusCode, 409)
      assert.equal(foreign.body.error.code, 'STOCK_PREPARATION_PROJECT_ABSENT')
    }
    assert.deepEqual(h.auditAppends.map((entry) => entry.action), ['project_target_archive'], 'only the one real transition is audited')
    assert.equal(h.registryRows().find((row) => row.tenant_id === OTHER_TENANT).status, 'active')
  } finally { h.restore() }
})

test('A-06 restore: archived → active on the SAME sheet, one audit row, and the pull is usable again (the dry run answers 200 ready)', async () => {
  const h = mount()
  try {
    const { sheetId } = h.seedRegistryRow(PROJECT, { archived: true })
    const refused = await dryRun(h)
    assert.equal(refused.statusCode, 409, JSON.stringify(refused.body))
    assert.equal(refused.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
    const res = await restore(h, PULLER)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.status, 'active')
    assert.equal(res.body.data.sheetId, sheetId)
    assert.equal(res.body.data.archivedAt, null)
    assert.equal(typeof res.body.data.restoredAt, 'string')
    assert.deepEqual(res.body.data.may, { create: false, archive: true, restore: false })
    const row = h.registryRows()[0]
    assert.equal(row.archived_at, null, '087 CHECK: active ⇔ archived_at NULL')
    assert.equal(row.restored_by, PULLER.id)
    assert.deepEqual(h.auditAppends.map((entry) => [entry.action, entry.projectId, entry.subjectId, entry.mode]), [['project_target_restore', PROJECT, sheetId, 'restored']])
    assert.ok(!h.provisioning.calls.some((call) => ['ensureObject', 'grantSheetRoleWrite'].includes(call[0])), 'no second sheet, no grant on restore')
    const pulled = await dryRun(h)
    assert.equal(pulled.statusCode, 200, `the pull works again after restore: ${JSON.stringify(pulled.body)}`)
    assert.equal(pulled.body.data.status, 'ready')
  } finally { h.restore() }
})

test('A-07 the 200 cap counts archived rows: a new create is 409 LIMIT; archiving frees nothing; restore at the cap is not re-checked', async () => {
  const h = mount()
  try {
    for (let i = 0; i < MAX_PROJECT_TARGETS_PER_TENANT; i += 1) h.seedRegistryRow(`PRJ-S4-CAP-${i}`, { archived: i === 0 })
    const create = () => projectSheet.call(h.routes, 'POST', TARGET_PATH, { user: PULLER, params: { projectNo: 'PRJ-S4-CAP-NEW' }, body: {} })
    let res = await create()
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_LIMIT')
    assert.equal((await archive(h, PULLER, 'PRJ-S4-CAP-1')).statusCode, 200)
    res = await create()
    assert.equal(res.statusCode, 409, 'archiving does not free a slot — the archived sheet is a live sheet')
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_LIMIT')
    const restored = await restore(h, PULLER, 'PRJ-S4-CAP-0')
    assert.equal(restored.statusCode, 200, `restore at the cap is not refused: ${JSON.stringify(restored.body)}`)
    assert.equal(h.registryRows().filter((row) => row.tenant_id === TENANT).length, MAX_PROJECT_TARGETS_PER_TENANT, 'no row added or removed')
    assert.ok(!h.provisioning.calls.some((call) => call[0] === 'ensureObject'), 'nothing provisioned')
  } finally { h.restore() }
})

/** Real action resolution and enqueue → expansion → plan producers, using only an empty synthetic source. */
async function seedPlannedExpansionJob(h, { jobId, target, projectNo = PROJECT }) {
  const at = '2026-10-09T00:00:00.000Z'
  const registry = createStockPreparationTableActionRegistry({
    actions: h.context.config.stockPreparationTableActions,
    resolveProjectTarget: (input) => resolveProjectTargetForAction({
      ...input, store: createStockPreparationProjectTargetStore({ db: h.db }),
      provisioning: h.provisioning, projectId: h.staging, env: process.env,
    }),
  })
  const action = await registry.getTableAction({ ...JOB_SCOPE, actionId: ACTION_ID, projectNo, targetPurpose: 'write' })
  assert.equal(action.target.sheetId, target.sheetId)
  assert.equal(action.target.objectId, target.objectId)
  await largeBomJobs.createLargeBomBackgroundExpansionJob({
    storage: h.context.storage, ...JOB_SCOPE, action,
    parameters: { projectNo },
    principal: PLATFORM_ADMIN.id, actor: PLATFORM_ADMIN.id, createJobId: () => jobId, now: () => at,
  })
  let reads = 0
  const expanded = await largeBomJobs.runLargeBomBackgroundExpansionJob({
    storage: h.context.storage, ...JOB_SCOPE, actionId: ACTION_ID, jobId, now: () => at,
    sourceAdapter: {
      async read(input) {
        reads += 1
        assert.equal(input.object, 'DN_PDM_PathExAttrInfo')
        assert.deepEqual(input.filters, { FileCode: projectNo })
        return { records: [], done: true, nextCursor: null, metadata: { filtersApplied: true } }
      },
    },
  })
  assert.equal(reads, 1)
  assert.equal(expanded.status, 'completed')
  largeBomJobs.assertAuthoritativeLargeBomExpansion(expanded)
  assert.deepEqual(expanded.artifact.rows, [])
  const planned = await largeBomJobs.planLargeBomBackgroundExpansionJob({
    storage: h.context.storage, ...JOB_SCOPE, actionId: ACTION_ID, jobId, existingRows: [], plannedAt: at,
  })
  largeBomJobs.assertAuthoritativeLargeBomPlan(planned)
  assert.deepEqual(planned.planArtifact.plan.decisions, [])
}

/** Status + error code: the short form a failure message names (a 200 is `200:ok`). */
const outcome = (res) => `${res.statusCode}:${(res.body && res.body.error && res.body.error.code) || 'ok'}`
/** The WHOLE answer — status, JSON body, headers and a streamed body — for "byte-identical" claims. */
const fullAnswer = (res) => JSON.stringify({
  status: res.statusCode,
  body: res.body === undefined ? null : res.body,
  headers: res.headers || {},
  sent: res.sentBuffer === undefined ? null : Buffer.from(res.sentBuffer).toString('base64'),
})

test('A-08 the §6 route table on one archived project: every write row refuses 409 ARCHIVED with no effect; every read row answers exactly as before the archive', async () => {
  const handoffCalls = []
  const handoffStore = {
    async get() { handoffCalls.push('get'); return null },
    async advance() { handoffCalls.push('advance'); throw new Error('unexpected handoff advance') },
    async claimNotification() { handoffCalls.push('claimNotification'); throw new Error('unexpected handoff claim') },
  }
  const previousMvp = process.env[MVP_PERSIST_ENV]
  process.env[MVP_PERSIST_ENV] = 'true'
  const h = mount({
    configExtras: {
      stockPreparationHandoff: {
        tenantId: TENANT,
        steps: [{ key: 'prep_entry', handlerUserIds: [PLATFORM_ADMIN.id] }],
        notify: { groupDestinationId: 'dest-prep-s4' },
        terminal: { groupDestinationIds: ['dest-warehouse-s4'], exportPath: '/stock-prep' },
      },
    },
    serviceExtras: {
      stockPreparationHandoffStore: handoffStore,
      stockPreparationConfirmationDecisionLease: { async acquire() { return { leaseId: 'lease_s4' } }, async release() { return true }, async renew() { return true } },
      stockPreparationXlsxExport: { async buildWorkbookBuffer() { return Buffer.from('xlsx-synthetic') } },
    },
  })
  try {
    const { sheetId, objectId } = h.seedRegistryRow(PROJECT)
    // One material row in THIS project's sheet, so the export has something to export.
    const fid = (fieldId) => h.provisioning.getFieldId(h.staging, objectId, fieldId)
    await h.records.createRecord({ sheetId, data: { [fid('projectNo')]: PROJECT, [fid('active')]: true, [fid('idempotencyKey')]: 'idem-s4-1' } })
    const projectTarget = { sheetId, objectId, fieldIdMap: {} }
    await seedPlannedExpansionJob(h, { jobId: 'job-s4-apply', target: projectTarget })
    await seedPlannedExpansionJob(h, { jobId: 'job-s4-plan', target: projectTarget })
    const jobParams = (jobId, applyJobId) => ({ actionId: ACTION_ID, jobId, ...(applyJobId ? { applyJobId } : {}) })
    // An apply job approved while the project was ACTIVE — the archive must stop its run.
    const approved = await projectSheet.call(h.routes, 'POST', APPLY_START_PATH, { user: PLATFORM_ADMIN, params: jobParams('job-s4-apply'), body: { confirm: { acceptManualConfirmHold: true } }, query: { tenantId: TENANT } })
    assert.equal(approved.statusCode, 202, JSON.stringify(approved.body))
    const applyJobId = approved.body.data.jobId

    // THE READ ROWS, BEFORE: 看板, 导出, 交接状态, conflict-policies list.
    const reads = {
      board: () => projectSheet.call(h.routes, 'GET', BOARD_PATH, { user: FLOOR, params: { projectNo: PROJECT }, query: { tenantId: TENANT } }),
      export: () => projectSheet.call(h.routes, 'GET', EXPORT_PATH, { user: FLOOR, query: { projectNo: PROJECT } }),
      handoffStatus: () => projectSheet.call(h.routes, 'GET', HANDOFF_PATH, { user: FLOOR, query: { projectNo: PROJECT } }),
      policiesList: () => projectSheet.call(h.routes, 'GET', POLICIES_PATH, { user: PLATFORM_ADMIN, params: { actionId: ACTION_ID }, query: { tenantId: TENANT, projectNo: PROJECT } }),
    }
    const before = {}
    const beforeFull = {}
    for (const [label, run] of Object.entries(reads)) {
      const res = await run()
      before[label] = outcome(res)
      beforeFull[label] = fullAnswer(res)
    }
    assert.equal(before.board, '200:ok', `the board answers while active: ${before.board}`)
    assert.equal(before.export, '200:ok', `the export answers while active: ${before.export}`)
    assert.equal(before.handoffStatus, '200:ok')
    assert.equal(before.policiesList, '200:ok')
    const targetBefore = await getTarget(h, FLOOR)
    assert.equal(targetBefore.statusCode, 200)

    // ARCHIVE.
    const archived = await archive(h, PULLER)
    assert.equal(archived.statusCode, 200, JSON.stringify(archived.body))
    const auditAfterArchive = h.auditAppends.length
    const recordWrites = () => h.records.calls.filter((call) => call[0] === 'createRecord' || call[0] === 'patchRecord').length
    const writesBefore = recordWrites()
    h.provisioning.calls.length = 0

    // THE WRITE ROWS — 建表、dry-run、apply、大 BOM、reconcile、mvp-persist、conflict-policies 写、结转、交接推进.
    const writes = [
      ['create', () => projectSheet.call(h.routes, 'POST', TARGET_PATH, { user: PULLER, params: { projectNo: PROJECT }, body: {} })],
      ['dry-run', () => dryRun(h)],
      ['apply', () => projectSheet.call(h.routes, 'POST', APPLY_PATH, { user: PULLER, params: { actionId: ACTION_ID }, body: { parameters: { projectNo: PROJECT } }, query: { tenantId: TENANT } })],
      ['reconcile', () => projectSheet.call(h.routes, 'POST', RECONCILE_PATH, { user: PLATFORM_ADMIN, params: { actionId: ACTION_ID }, body: { parameters: { projectNo: PROJECT } } })],
      ['mvp-persist', () => projectSheet.call(h.routes, 'POST', MVP_PERSIST_PATH, { user: PLATFORM_ADMIN, params: { actionId: ACTION_ID }, body: { parameters: { projectNo: PROJECT } } })],
      ['large-bom expansion-start', () => projectSheet.call(h.routes, 'POST', JOBS_PATH, { user: PULLER, params: { actionId: ACTION_ID }, body: { parameters: { projectNo: PROJECT } }, query: { tenantId: TENANT } })],
      ['large-bom plan', () => projectSheet.call(h.routes, 'POST', PLAN_PATH, { user: PLATFORM_ADMIN, params: jobParams('job-s4-plan'), body: {}, query: { tenantId: TENANT } })],
      ['large-bom apply-start', () => projectSheet.call(h.routes, 'POST', APPLY_START_PATH, { user: PLATFORM_ADMIN, params: jobParams('job-s4-plan'), body: { confirm: { acceptManualConfirmHold: true } }, query: { tenantId: TENANT } })],
      ['large-bom apply-run', () => projectSheet.call(h.routes, 'POST', APPLY_RUN_PATH, { user: PLATFORM_ADMIN, params: jobParams('job-s4-apply', applyJobId), body: {}, query: { tenantId: TENANT } })],
      ['conflict-policies save', () => projectSheet.call(h.routes, 'PUT', POLICIES_PATH, { user: PLATFORM_ADMIN, params: { actionId: ACTION_ID }, body: {}, query: { tenantId: TENANT, projectNo: PROJECT } })],
      ['conflict-policies delete', () => projectSheet.call(h.routes, 'DELETE', POLICIES_PATH, { user: PLATFORM_ADMIN, params: { actionId: ACTION_ID }, body: {}, query: { tenantId: TENANT, projectNo: PROJECT } })],
      ['carry confirm', () => projectSheet.call(h.routes, 'POST', CARRY_PATH, { user: PLATFORM_ADMIN, body: { decision: { idempotencyKey: JSON.stringify({ projectNo: PROJECT }) } } })],
      ['handoff advance', () => projectSheet.call(h.routes, 'POST', HANDOFF_ADVANCE_PATH, { user: PLATFORM_ADMIN, body: { projectNo: PROJECT, fromStepKey: 'prep_entry' } })],
    ]
    for (const [label, run] of writes) {
      const res = await run()
      assert.equal(res.statusCode, 409, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED', label)
      assert.deepEqual({ ...res.body.error.details }, { field: 'projectNo' }, `${label}: values-free details`)
    }
    assert.equal(h.auditAppends.length, auditAfterArchive, 'no write row wrote an audit row')
    assert.equal(recordWrites(), writesBefore, 'no record was created or patched')
    assert.ok(!h.provisioning.calls.some((call) => call[0] === 'ensureObject' || call[0] === 'grantSheetRoleWrite'), 'no sheet provisioned, no grant')
    assert.ok(!handoffCalls.includes('advance') && !handoffCalls.includes('claimNotification'), 'the handoff cursor did not move and nobody was notified')
    const applyJob = await h.context.storage.get(largeBomJobs.__internals.checkpointApplyJobKey({ ...JOB_SCOPE, actionId: ACTION_ID, applyJobId }))
    assert.equal(applyJob.status, 'queued', 'the approved apply job did not run a chunk')
    assert.equal(applyJob.checkpoint.nextDecisionIndex, 0)

    // THE READ ROWS, AFTER: byte-identical to what they answered before the archive (status, body,
    // headers, the exported workbook).
    for (const [label, run] of Object.entries(reads)) {
      const res = await run()
      assert.equal(outcome(res), before[label], `${label} answers exactly as before the archive`)
      assert.equal(fullAnswer(res), beforeFull[label], `${label}: the whole answer is byte-identical`)
    }
    // GET target still reads; only the lifecycle fields move.
    const target = await getTarget(h, FLOOR)
    assert.equal(target.statusCode, 200)
    assert.equal(target.body.data.status, 'archived')
    const withoutLifecycle = (data) => {
      const { status: _status, archivedAt: _archivedAt, may: _may, ...rest } = data
      return rest
    }
    assert.deepEqual(withoutLifecycle(target.body.data), withoutLifecycle(targetBefore.body.data), 'GET target: only status, archivedAt and may.* change')
    assert.notEqual(target.body.data.archivedAt, targetBefore.body.data.archivedAt)

    // RESTORE → the same lane is open again (positive control for every 409 above).
    assert.equal((await restore(h, PULLER)).statusCode, 200)
    const planned = await projectSheet.call(h.routes, 'POST', PLAN_PATH, { user: PLATFORM_ADMIN, params: jobParams('job-s4-plan'), body: {}, query: { tenantId: TENANT } })
    assert.equal(planned.statusCode, 200, `the plan runs again after restore: ${JSON.stringify(planned.body)}`)
    assert.equal((await dryRun(h)).statusCode, 200)
  } finally {
    h.restore()
    if (previousMvp === undefined) delete process.env[MVP_PERSIST_ENV]
    else process.env[MVP_PERSIST_ENV] = previousMvp
  }
})

test('A-10 (fix round 1) the create-replay race: an archive after the unlocked read → 409 ARCHIVED, nothing healed; an archive during the heal waits for it', async () => {
  const create = (h) => projectSheet.call(h.routes, 'POST', TARGET_PATH, { user: PULLER, params: { projectNo: PROJECT }, body: {} })
  const packWrites = (h) => h.db.calls.filter((call) => call.startsWith(`upsertOne:${projectSheet.PACK_INSTALL_TABLE}`) || call.startsWith(`insertOne:${projectSheet.PACK_INSTALL_TABLE}`)).length

  // (a) The route's FIRST registry read (outside any lock) answers ACTIVE; a real archive, through its
  // own route, commits immediately after it — the window the locked re-check exists to close.
  let h = mount({ grantRoleIds: ['stock-prep_frontline'] })
  try {
    h.seedRegistryRow(PROJECT)
    const unlockedRead = h.db.selectOne
    let raced = false
    h.db.selectOne = async (table, where) => {
      const row = await unlockedRead.call(h.db, table, where)
      if (!raced && table === projectSheet.PROJECT_TARGET_TABLE && row && row.status === 'active') {
        raced = true
        const snapshot = { ...row }
        const archived = await archive(h, PULLER)
        assert.equal(archived.statusCode, 200, `the racing archive commits: ${JSON.stringify(archived.body)}`)
        return snapshot
      }
      return row
    }
    const res = await create(h)
    assert.ok(raced, 'the interleaving was forced')
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
    assert.deepEqual({ ...res.body.error.details }, { field: 'projectNo' })
    assert.deepEqual(h.provisioning.grantCalls, [], 'the G1 grant was NOT re-run on the archived sheet')
    assert.ok(!h.provisioning.calls.some((call) => ['ensureMissingObjectFields', 'patchObjectFieldProperty', 'ensureObject'].includes(call[0])), 'no pack or sheet write')
    assert.equal(packWrites(h), 0, 'no pack ledger write')
    assert.deepEqual(h.auditAppends.map((entry) => entry.action), ['project_target_archive'], 'only the archive is audited')
    assert.equal(h.registryRows()[0].status, 'archived')
  } finally { h.restore() }

  // (b) The replay is INSIDE its heal (the G1 grant port is mid-call) when an archive arrives: the
  // archive must wait for the per-tenant lock the replay holds, then archive.
  h = mount({ grantRoleIds: ['stock-prep_frontline'] })
  try {
    h.seedRegistryRow(PROJECT)
    const grantPort = h.provisioning.grantSheetRoleWrite
    let archiveInFlight = null
    let statusWhileHealing = null
    h.provisioning.grantSheetRoleWrite = async (input) => {
      if (!archiveInFlight) {
        archiveInFlight = archive(h, PULLER)
        for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => { setImmediate(resolve) })
        statusWhileHealing = h.registryRows()[0].status
      }
      return grantPort.call(h.provisioning, input)
    }
    const replay = await create(h)
    assert.equal(replay.statusCode, 200, JSON.stringify(replay.body))
    assert.equal(replay.body.data.created, false)
    assert.equal(statusWhileHealing, 'active', 'the archive did not slip in while the replay was healing')
    const archived = await archiveInFlight
    assert.equal(archived.statusCode, 200, `the archive then goes through: ${JSON.stringify(archived.body)}`)
    assert.equal(h.registryRows()[0].status, 'archived')
    assert.deepEqual(h.auditAppends.map((entry) => entry.action), ['project_target_grant', 'project_target_archive'], 'the heal finished (and was audited) before the archive')
  } finally { h.restore() }
})

// ── A-09: confirm 裁决 on the ledger substrate ─────────────────────────────────────────────────────

const STAGING = `${TENANT}:integration-core`
const LEDGER_SHEET = 'sheet_s4_confirmation_decisions'
const DECISION_ID = 'decision_s4_1'
const FINGERPRINT = 'sha16:0123456789abcdef'

function mountLedger({ switchOn = true, registryGetFails = false } = {}) {
  const routes = new Map()
  const auditAppends = []
  const row = physicalRow(STAGING, LEDGER_OBJECT_ID, {
    decisionId: DECISION_ID,
    projectNo: PROJECT,
    conflictType: FIRST_CUT_CONFLICT_TYPE,
    status: STATUSES.PENDING,
    inputFingerprint: FINGERPRINT,
    sourceRevision: 'rev-s4',
  }, 'rec_s4_1')
  row.sheetId = LEDGER_SHEET
  const records = makeStrictRecordsApi({ stagingProjectId: STAGING, objectIdBySheetId: { [LEDGER_SHEET]: LEDGER_OBJECT_ID }, rowsBySheet: { [LEDGER_SHEET]: [row] } })
  const provisioning = {
    ...makeFakeProvisioning({ stagingProjectId: STAGING, sheetIdByObjectId: { [LEDGER_OBJECT_ID]: LEDGER_SHEET } }),
    async ensureObject() { throw new Error('unexpected provisioning write: ensureObject') },
  }
  const db = projectSheet.makeMemoryDb()
  const store = createStockPreparationProjectTargetStore({ db })
  const services = {}
  for (const [name, methods] of Object.entries({
    externalSystemRegistry: ['upsertExternalSystem', 'getExternalSystem', 'getExternalSystemForAdapter', 'deleteExternalSystem', 'listExternalSystems'],
    adapterRegistry: ['createAdapter', 'listAdapterKinds'],
    pipelineRegistry: ['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns'],
    pipelineRunner: ['runPipeline'],
    deadLetterStore: ['listDeadLetters'],
    stagingInstaller: ['installStaging', 'listStagingDescriptors'],
    templateRegistry: ['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate'],
    readSourceConfigStore: ['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime'],
    readSourceCompositionConfigStore: ['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime'],
    bridgeAgentChecklistStore: ['saveVersion', 'approve', 'retire', 'getForApply'],
  })) {
    services[name] = {}
    for (const method of methods) services[name][method] = async () => { throw new Error(`unexpected service call: ${method}`) }
  }
  services.stockPreparationAuditStore = { async append(entry) { auditAppends.push(entry); return { ok: true } } }
  services.tenantPrincipalDirectory = { async verifyTenantMembership() { return { member: true } } }
  services.stockPreparationProjectTargetStore = registryGetFails
    ? { ...store, async get() { throw Object.assign(new Error('registry unreachable'), { status: 503, code: 'SYNTHETIC_REGISTRY_DOWN' }) } }
    : store
  const previous = process.env[PROJECT_SHEETS_ENABLED_ENV]
  if (switchOn) process.env[PROJECT_SHEETS_ENABLED_ENV] = 'true'
  else delete process.env[PROJECT_SHEETS_ENABLED_ENV]
  httpRoutes.registerIntegrationRoutes({
    context: { api: { http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } }, multitable: { provisioning, records } }, storage: new Map(), config: {} },
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
  return {
    routes, auditAppends, records, db, store,
    registerProject(status) {
      db.rowsOf(projectSheet.PROJECT_TARGET_TABLE).push({ id: 'seed-ledger', tenant_id: TENANT, project_no: PROJECT, sheet_id: 'sheet_s4_ledger_project', object_id: 'plm_stock_preparation_sandbox_p_000000000000000000000000', status, archived_at: status === 'archived' ? new Date('2026-10-09T00:00:00Z') : null, created_at: new Date('2026-10-08T00:00:00Z') })
      db.calls.length = 0
    },
    restore() { if (previous === undefined) delete process.env[PROJECT_SHEETS_ENABLED_ENV]; else process.env[PROJECT_SHEETS_ENABLED_ENV] = previous },
  }
}

const confirmDecision = (m) => projectSheet.call(m.routes, 'POST', CONFIRM_PATH, {
  user: FLOOR,
  body: { decisionId: DECISION_ID, inputFingerprint: FINGERPRINT, resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS },
})
const ledgerStatus = (m) => m.records.rows(LEDGER_SHEET)[0].data[physicalFieldId(STAGING, LEDGER_OBJECT_ID, 'status')]

test('A-09 confirm 裁决: archived → 409 ARCHIVED with the ledger untouched; value read-back still answers; restore → confirms; switch off → never consulted; registry down → refused', async () => {
  // Switch ON, the decision's project ARCHIVED.
  let m = mountLedger()
  try {
    m.registerProject('archived')
    const res = await confirmDecision(m)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
    assert.deepEqual({ ...res.body.error.details }, { field: 'projectNo' })
    assert.equal(m.records.patchCallCount, 0, 'the ledger was not patched (不改账本)')
    assert.equal(ledgerStatus(m), STATUSES.PENDING)
    assert.ok(m.db.calls.some((call) => call === `selectOne:${projectSheet.PROJECT_TARGET_TABLE}`), 'the registry was asked')
    // The intent row lands first, as for every refusal of this route ("audit row + error").
    assert.deepEqual(m.auditAppends.map((entry) => [entry.action, entry.mode, entry.projectId]), [['exception_resolve', 'confirmation_decision_requested', PROJECT]])
    // 录入值回读 is a read: it still answers on an archived project.
    const readBack = await projectSheet.call(m.routes, 'GET', VALUE_ENTRY_PATH, { user: FLOOR, query: { decisionId: DECISION_ID } })
    assert.equal(readBack.statusCode, 200, JSON.stringify(readBack.body))
    // RESTORE (the store's own transition) → the very same confirm goes through.
    await m.store.restore({ tenantId: TENANT, projectNo: PROJECT, actorId: PULLER.id })
    const after = await confirmDecision(m)
    assert.equal(after.statusCode, 200, JSON.stringify(after.body))
    assert.equal(ledgerStatus(m), STATUSES.CONFIRMED)
  } finally { m.restore() }

  // An ACTIVE project, and a ledger row whose project the registry does not hold: unchanged (200).
  for (const status of ['active', null]) {
    m = mountLedger()
    try {
      if (status) m.registerProject(status)
      const res = await confirmDecision(m)
      assert.equal(res.statusCode, 200, `${status || 'unregistered'}: ${JSON.stringify(res.body)}`)
    } finally { m.restore() }
  }

  // Switch OFF: the registry is never consulted, the archived row notwithstanding — byte-identical.
  m = mountLedger({ switchOn: false })
  try {
    m.registerProject('archived')
    const res = await confirmDecision(m)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(m.db.calls, [], 'switch off: no registry statement')
  } finally { m.restore() }

  // Switch ON and the registry unreachable: refused (fail-closed), the ledger untouched.
  m = mountLedger({ registryGetFails: true })
  try {
    const res = await confirmDecision(m)
    assert.equal(res.statusCode, 503, JSON.stringify(res.body))
    assert.equal(m.records.patchCallCount, 0)
  } finally { m.restore() }
})

;(async () => {
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log(`  ${name} OK`)
    } catch (error) {
      failed += 1
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    }
  }
  if (failed) {
    console.error(`stock-preparation-project-target-archive.test.cjs FAILED (${failed})`)
    process.exit(1)
  }
  console.log('✓ stock-preparation-project-target-archive')
})()
