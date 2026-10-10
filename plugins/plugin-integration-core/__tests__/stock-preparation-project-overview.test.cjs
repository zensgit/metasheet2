'use strict'

// 一个项目一张备料表 — S3 项目总览表 + O2(a) 项目级列 + 目录按登记行枚举 (ADR
// adr-stock-prep-project-sheets-20261008 §5 / §6 「首页与项目查询」 / §7; register R-37; owner Q5:
// 宿主级只读 + O1 + O2(a), no O3). The real route stack over the shared project-sheet substrate
// (support/stock-preparation-project-sheet-harness.cjs) whose host fake now stamps and reports
// `systemKind` exactly as provisioning.ts does.
//
//   O-01 THE TEMPLATE: the overview's field ids are exactly the pinned aggregate set, every type is one
//        of string / number / boolean / date (no detail row can structurally land), the key is
//        `projectNo`, and the two views filter `status`. The system-kind literal equals the host's
//        (packages/core-backend/src/multitable/system-sheet-predicate.ts) and the own-base anchor
//        treats the overview as a one-way partner.
//   O-02 THE POSTURE is the web's `stockPrepPosture` word for word, with 「已归档」 first — even over a
//        pending count.
//   O-03 THE DEEP LINK (O1) is `/multitable/<sheetId>/<todoViewId>`, built from the registry row and the
//        host-derived view id only; null when either is missing. Mutation: build it from anything a
//        request carries and O-10 (the refresh writes the link the registry + host derive) reds.
//   O-04 SWITCH OFF: GET / PUT project-fields and the refresh answer 404 DISABLED with ZERO IO for an
//        OPERATE caller; a read-only caller is refused by the gate first.
//   O-05 PROJECT FIELDS, the whitelist: an unknown body key is 400; an over-long text, a non-string, a
//        malformed day and an empty patch are 422 naming the FIELD and never the value; an absent
//        project is 409 ABSENT and an archived one 409 ARCHIVED (§6: 「项目级列修改 | 同一个 409」) with
//        no update statement and no audit row.
//   O-06 PROJECT FIELDS, the write: one transaction under the tenant lock, FOR UPDATE, compare-and-set
//        on `status: 'active'`; the GET reads it back; the audit row names the columns changed as a
//        count map and NO append anywhere carries a value; the GET target / list projections never
//        carry the three texts; clearing with null / '' works.
//   O-07 THE REFRESH creates the overview ONCE: `ensureObject` is called with `systemKind:
//        'stock_prep_overview'`, the two views are ensured, the sheet lands beside the ledger / main
//        table (own-base anchor), and a second refresh calls neither ensureObject nor ensureView.
//   O-08 FAIL-CLOSED ON THE STAMP: a host that does not report the kind back (an older host) is 409
//        NOT_STAMPED and no row is written; an existing unstamped sheet is the same 409.
//   O-09 THE BOUNDED COUNT of one project sheet: rows / active / 采购未完成 / 仓库未完成 by the fill
//        view's `active !== false` rule and `done !== true`; past PULL_TARGET_MAX_PAGES the counts are
//        a floor and `bounded` is true; an unreadable sheet degrades to ready:false.
//   O-10 THE PROJECTION, end to end: one overview row per registry row (active AND archived), the
//        deep link, the posture text, the O2(a) texts, the measured counts, pending = 0 with
//        ledgerReady=false when the ledger is absent, `countsAt` set (「截至」); the registry's count
//        columns are stamped and the list route shows them; a second refresh with nothing changed
//        writes nothing; a changed project field patches exactly that row; audit
//        `project_overview_refresh` carries counts only.
//   O-11 `last_pull_*`: a dry-run on a registered project stamps `previewed`; a run that throws a typed
//        error stamps `refused` + the code; a stamp that fails never fails the pull; the switch-off
//        dry-run stamps nothing.
//   O-12 THE DIRECTORY enumerates registry rows under the union opt-in with the switch on: archived
//        flag, pulledRowCount, missingComponentsCount, source `pull_target`; a 「平台登记」-only row
//        carries `archived: null`; switch off → the three keys are absent (byte-identical to S2).
//   O-13 (S4 carry-over) the create REPLAY's column probe: a host read failure that is not an
//        object-scope refusal is 503 TARGET_SCHEMA_UNAVAILABLE (not a raw 500); a scope refusal still
//        degrades to the ledger's word (200, already installed).
//
// FIX ROUND 1 (register R-37):
//   O-07  (R6) only the PULL tier creates the overview (`ensure`, and the project-target create when it is
//         absent), with the G1 READ grant; the OPERATE refresh never creates (409 ABSENT) and is cooled
//         down (200 `fresh: false`, no refresh IO); O-07b the create's best-effort overview leg.
//   O-08  (R8) an older host is 503 before ANY IO; an unstamped sheet at the derived id is 409 with nothing
//         created and no list handle; the host's in-transaction adoption refusal and a column-less
//         database (E2) are typed.
//   O-10  (R7) a refresh that measures the same numbers writes nothing and leaves 「截至」 where it was.
//   O-11  (R10) a refusal code without error-code shape is stored as UNKNOWN with one values-free warn.
//   O-14  (R3) concurrent refreshes under the overview lock leave one row per project; duplicates and
//         orphans (unregistered projects) are deleted through the plugin write port.
//   O-15  (R5) create / archive / restore / project fields / dry-run / confirm update THAT project's row at
//         once; an overview failure never changes the event's answer and logs a code only.
//   O-16  (R2) the DATE column reads back as the stored day in UTC+ (and UTC−) processes.
//   O-17  (R13) control characters / NUL in the free texts are a typed 400.
//   O-18  (E2) unknown errors on the S3 routes are a fixed values-free 500; a column-less database a 503.
//   O-19  (R10) the store maps a bad code shape to UNKNOWN and never throws over it.
//
// S3 FOLLOW-UPS (the S3 final review's merge note, register R-37):
//   O-24  (A) the suite runs on support/fail-closed-suite-runner.cjs: a hang with nothing alive exits 1 (exit
//         sentinel), a hang that keeps the loop alive times out per test — never exit 0 past a hang.
//   O-25  (B) another PROCESS holding the overview lock: the refresh route is 409 BUSY with nothing written or
//         audited, and the cooldown is cleared (the first click after the lock frees refreshes for real).
//   O-26  (C) a project write that fails — in the full pass (O-26), in the drain of an event deferred into the
//         refresh (O-26b), or on the per-event path (O-26c) — is never swallowed: the refresh is a typed 503
//         REFRESH_INCOMPLETE audited `incomplete` (counts only), and the project stays dirty until a writer heals it.
//   O-27  (D) the refresh reads every page of the overview before it deletes an orphan; past the read bound a
//         project is re-projected by number, never created blind.
//
// Synthetic values only.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const projectSheet = require(path.join(__dirname, 'support', 'stock-preparation-project-sheet-harness.cjs'))
// S3 follow-up A: exit sentinel + per-test timeout (a hung test can no longer end the process with exit 0).
const { runFailClosedSuite } = require(path.join(__dirname, 'support', 'fail-closed-suite-runner.cjs'))
const overview = require(path.join(LIB, 'stock-preparation-project-overview.cjs'))
const {
  STOCK_PREPARATION_PROJECT_OVERVIEW_TABLE_TEMPLATE,
  STOCK_PREPARATION_PROJECT_OVERVIEW_VIEWS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { stockPreparationOwnBasePairPartners } = require(path.join(LIB, 'stock-preparation-own-base.cjs'))
const { STOCK_PREP_ADMIN, STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID } = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))
const { PULL_TARGET_PAGE_LIMIT, PULL_TARGET_MAX_PAGES } = require(path.join(LIB, 'stock-preparation-pull-target-scan.cjs'))
const { PROJECT_FIELD_KEYS, PROJECT_FIELD_TEXT_LIMITS } = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))

const TENANT = 'tenant-s3-overview'
const PROJECT = 'PRJ-S3-O1'
const PROJECT_B = 'PRJ-S3-O2'
const STAGING = `${TENANT}:integration-core`
const ACTION_ID = PLM_STOCK_PREPARATION_ACTION_ID
const OVERVIEW_OBJECT = overview.STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID
const KIND = overview.STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND

const FIELDS_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/project-fields'
const REFRESH_PATH = '/api/integration/stock-preparation/project-overview/refresh'
const ENSURE_PATH = '/api/integration/stock-preparation/project-overview/ensure'
const ARCHIVE_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/archive'
const RESTORE_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/restore'
const LIST_PATH = '/api/integration/stock-preparation/project-targets'
const TARGET_PATH = '/api/integration/stock-preparation/projects/:projectNo/target'
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const DIRECTORY_PATH = '/api/integration/stock-preparation/operator/projects'

const FLOOR = Object.freeze({ id: 'u_s3_floor', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const READ_ONLY = Object.freeze({ id: 'u_s3_read', tenantId: TENANT, permissions: [STOCK_PREP_READ] })
const PULLER = Object.freeze({ id: 'u_s3_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const WORKBENCH_ADMIN = Object.freeze({ id: 'u_s3_wb', tenantId: TENANT, permissions: [STOCK_PREP_ADMIN] })

const RESPONSIBLE = '某同步负责人'
const NOTE = '一句自由文本备注'
const DAY = '2026-12-24'

const getFields = (h, user, projectNo = PROJECT) => projectSheet.call(h.routes, 'GET', FIELDS_PATH, { user, params: { projectNo }, query: { tenantId: TENANT } })
// Fix round 1 (R9): the project-level columns are a PARTIAL update — PATCH.
const patchFields = (h, user, body, projectNo = PROJECT) => projectSheet.call(h.routes, 'PATCH', FIELDS_PATH, { user, params: { projectNo }, body })
const refresh = (h, user = FLOOR) => projectSheet.call(h.routes, 'POST', REFRESH_PATH, { user, body: {} })
const ensure = (h, user = PULLER) => projectSheet.call(h.routes, 'POST', ENSURE_PATH, { user, body: {} })
const listTargets = (h, user = FLOOR) => projectSheet.call(h.routes, 'GET', LIST_PATH, { user, query: { tenantId: TENANT } })
const getTarget = (h, user, projectNo = PROJECT) => projectSheet.call(h.routes, 'GET', TARGET_PATH, { user, params: { projectNo }, query: { tenantId: TENANT } })
const createTarget = (h, user = PULLER, projectNo = PROJECT) => projectSheet.call(h.routes, 'POST', TARGET_PATH, { user, params: { projectNo }, body: {} })
const archive = (h, user = PULLER, projectNo = PROJECT) => projectSheet.call(h.routes, 'POST', ARCHIVE_PATH, { user, params: { projectNo }, body: { confirmProjectNo: projectNo } })
const restore = (h, user = PULLER, projectNo = PROJECT) => projectSheet.call(h.routes, 'POST', RESTORE_PATH, { user, params: { projectNo }, body: { confirmProjectNo: projectNo } })
const dryRun = (h, user = PULLER, projectNo = PROJECT) => projectSheet.call(h.routes, 'POST', DRY_RUN_PATH, { user, params: { actionId: ACTION_ID }, body: { parameters: { projectNo } }, query: { tenantId: TENANT } })
const directory = (h, user = FLOOR) => projectSheet.call(h.routes, 'GET', DIRECTORY_PATH, { user, query: { includePullTargets: '1' } })

/** The refresh cooldown is per tenant per process, on `Date.now()`; tests step a FAKE clock past it. */
const realDateNow = Date.now
let clockOffsetMs = 0
Date.now = () => realDateNow() + clockOffsetMs
const passCooldown = () => { clockOffsetMs += overview.PROJECT_OVERVIEW_REFRESH_COOLDOWN_MS + 1000 }

/** A logger that keeps what the routes warn, to pin that a warn is values-free. */
function capturingLogger() {
  const warnings = []
  return { warnings, info() {}, error() {}, warn(message, meta) { warnings.push({ message, meta }) } }
}

function mount(options = {}) {
  const h = projectSheet.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, switchOn: true, stampsSystemKind: true, ...options })
  // The harness records fake ignores filters / offsets and does not persist a patch; the overview
  // needs both (it narrows a project sheet by project number and reads its own rows back), so the
  // fake is tightened HERE, on the same object the routes read through `context.api.multitable`.
  const rows = []
  let seq = 0
  h.records.queryRecords = async (input = {}) => {
    h.records.calls.push(['queryRecords', input.sheetId])
    const filters = input.filters || {}
    const hit = rows.filter((row) => row.sheetId === input.sheetId && Object.entries(filters).every(([k, v]) => row.data[k] === v))
    const offset = Number(input.offset || 0)
    const limit = Number(input.limit || hit.length)
    return projectSheet.clone(hit.slice(offset, offset + limit))
  }
  // Fix round 2 (F3): the HOST refuses a generic record write to the stamped overview for every caller (this
  // fake mirrors plugin-scope.ts); the overview's own writes go through `records.stockPreparationOverview`,
  // which names a PROJECT and lets the host derive the sheet. `raw` is what both reach once admitted, so a
  // suite that injects a failure or a yield into the OVERVIEW writes overrides `h.overviewPort.*`.
  const isStampedOverview = (sheetId) => [...h.provisioning.objects.entries()].some(([key, object]) => {
    const slash = key.lastIndexOf('/')
    return object.systemKind === KIND && h.provisioning.sheetIdOf(key.slice(0, slash), key.slice(slash + 1)) === sheetId
  })
  const refuseOverview = (sheetId) => {
    if (isStampedOverview(sheetId)) {
      throw Object.assign(new Error('generic write to the overview'), { status: 403, code: 'STOCK_PREP_OVERVIEW_READ_ONLY', details: { reason: 'generic_write' } })
    }
  }
  const raw = {
    createRecord(input = {}) {
      seq += 1
      const created = { id: `rec_${seq}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
      rows.push(created)
      return projectSheet.clone(created)
    },
    patchRecord(input = {}) {
      const row = rows.find((candidate) => candidate.id === input.recordId && candidate.sheetId === input.sheetId)
      assert.ok(row, 'patchRecord addresses a row the fake holds')
      Object.assign(row.data, input.changes || {})
      row.version += 1
      return projectSheet.clone(row)
    },
    deleteRecord(input = {}) {
      const index = rows.findIndex((candidate) => candidate.id === input.recordId && candidate.sheetId === input.sheetId)
      assert.ok(index >= 0, 'deleteRecord addresses a row the fake holds')
      rows.splice(index, 1)
      return { id: input.recordId, sheetId: input.sheetId, version: 1 }
    },
  }
  h.records.createRecord = async (input = {}) => {
    h.records.calls.push(['createRecord', input.sheetId])
    refuseOverview(input.sheetId)
    return raw.createRecord(input)
  }
  h.records.patchRecord = async (input = {}) => {
    h.records.calls.push(['patchRecord', input.sheetId])
    refuseOverview(input.sheetId)
    return raw.patchRecord(input)
  }
  h.records.deleteRecord = async (input = {}) => {
    h.records.calls.push(['deleteRecord', input.sheetId])
    refuseOverview(input.sheetId)
    return raw.deleteRecord(input)
  }
  const portSheet = (projectId) => {
    const sheetId = h.provisioning.sheetIdOf(projectId, OVERVIEW_OBJECT)
    if (!isStampedOverview(sheetId)) throw Object.assign(new Error('not the overview'), { status: 403, code: 'STOCK_PREP_OVERVIEW_READ_ONLY', details: { reason: 'not_overview' } })
    return sheetId
  }
  h.overviewPort = {
    async createRecord({ projectId, data } = {}) {
      const sheetId = portSheet(projectId)
      h.records.calls.push(['overview.createRecord', sheetId])
      return raw.createRecord({ sheetId, data })
    },
    async patchRecord({ projectId, recordId, changes } = {}) {
      const sheetId = portSheet(projectId)
      h.records.calls.push(['overview.patchRecord', sheetId])
      return raw.patchRecord({ sheetId, recordId, changes })
    },
    async deleteRecord({ projectId, recordId } = {}) {
      const sheetId = portSheet(projectId)
      h.records.calls.push(['overview.deleteRecord', sheetId])
      return raw.deleteRecord({ sheetId, recordId })
    },
  }
  // The port object the routes see delegates to `h.overviewPort` at call time (so a suite can swap a method).
  h.records.stockPreparationOverview = {
    createRecord: (input) => h.overviewPort.createRecord(input),
    patchRecord: (input) => h.overviewPort.patchRecord(input),
    deleteRecord: (input) => h.overviewPort.deleteRecord(input),
  }
  h.rows = rows
  return h
}

/** Physical id the harness host derives for a logical field of an object. */
const phys = (objectId, fieldId) => `fld_${objectId.slice(-8)}_${fieldId}`

/** Put `n` main-template rows for `projectNo` into its project sheet, `activeCount` of them active. */
function seedProjectRows(h, projectNo, { total, active, procurementDone = 0, warehouseDone = 0 }) {
  const objectId = h.projectObjectId(projectNo)
  const sheetId = h.provisioning.sheetIdOf(STAGING, objectId)
  for (let i = 0; i < total; i += 1) {
    const isActive = i < active
    h.rows.push({
      id: `${projectNo}_${i}`,
      sheetId,
      version: 1,
      data: {
        [phys(objectId, 'projectNo')]: projectNo,
        [phys(objectId, 'active')]: isActive,
        [phys(objectId, 'procurementDone')]: isActive && i < procurementDone,
        [phys(objectId, 'warehouseDone')]: isActive && i < warehouseDone,
      },
    })
  }
  return { objectId, sheetId }
}

const overviewSheetId = (h) => h.provisioning.sheetIdOf(STAGING, OVERVIEW_OBJECT)
const overviewRows = (h) => h.rows.filter((row) => row.sheetId === overviewSheetId(h))
const logical = (row, key) => row.data[phys(OVERVIEW_OBJECT, key)]
const hostWrites = (h) => h.provisioning.calls.filter((c) => ['ensureObject', 'ensureView', 'ensureMissingObjectFields', 'patchObjectFieldProperty', 'grantSheetRoleWrite', 'grantOverviewRoleRead'].includes(c[0]))

function registryRow(h, projectNo = PROJECT) {
  return h.registryRows().find((row) => row.project_no === projectNo)
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ── O-01 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-01 the template: pinned aggregate columns only, no select/detail, key projectNo, two status views, host kind literal, own-base partner', () => {
  const template = STOCK_PREPARATION_PROJECT_OVERVIEW_TABLE_TEMPLATE
  assert.equal(template.objectId, OVERVIEW_OBJECT)
  assert.deepEqual(template.keyFields, ['projectNo'])
  assert.deepEqual(template.fields.map((f) => f.id), [
    'projectNo', 'sheetLink', 'posture', 'postureKey', 'status', 'responsibleLabel', 'note', 'plannedFinishOn',
    'rowCount', 'activeRowCount', 'countsBounded', 'procurementOpenCount', 'warehouseOpenCount',
    'pendingDecisionCount', 'missingComponentsCount', 'lastPullAt', 'lastPullOutcome', 'countsAt',
  ])
  assert.deepEqual([...overview.STOCK_PREPARATION_PROJECT_OVERVIEW_FIELD_IDS], template.fields.map((f) => f.id))
  for (const field of template.fields) {
    assert.ok(['string', 'number', 'boolean', 'date'].includes(field.type), `${field.id}: aggregate type only (got ${field.type})`)
    assert.ok(typeof field.labelZh === 'string' && field.labelZh.length > 0, `${field.id} carries a Chinese label`)
  }
  // NONE of the main template's detail columns is here — the only id the two share is the key.
  const detailColumns = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((f) => f.id).filter((id) => id !== 'projectNo')
  assert.ok(detailColumns.length > 20, 'the main template really is a detail-row template')
  for (const detailColumn of detailColumns) {
    assert.ok(!template.fields.some((f) => f.id === detailColumn), `${detailColumn} is not an overview column`)
  }
  assert.deepEqual(STOCK_PREPARATION_PROJECT_OVERVIEW_VIEWS.map((v) => [v.id, v.status]), [['overview-active', 'active'], ['overview-archived', 'archived']])
  // The host literal — pinned against the host SOURCE, the way own-base pins core's base-id rule.
  const predicate = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'packages', 'core-backend', 'src', 'multitable', 'system-sheet-predicate.ts'), 'utf8')
  assert.equal(KIND, 'stock_prep_overview')
  assert.ok(predicate.includes(`'${KIND}'`), 'the host system-sheet predicate declares the overview kind')
  // One-way anchor: the overview follows the pair; nothing follows the overview.
  assert.deepEqual(stockPreparationOwnBasePairPartners(OVERVIEW_OBJECT).length, 2)
  assert.ok(!stockPreparationOwnBasePairPartners(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId).includes(OVERVIEW_OBJECT))
  assert.deepEqual([...PROJECT_FIELD_KEYS], ['responsibleLabel', 'note', 'plannedFinishOn'])
})

// ── O-02 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-02 the posture mirrors the web word for word; 「已归档」 first even over pending work', () => {
  const p = overview.projectOverviewPosture
  assert.deepEqual(p({ archived: true, pendingDecisionCount: 3, missingComponentsCount: 2, pulledRowCount: 9 }), { key: 'archived', zh: '已归档', en: 'Archived', tone: 'neutral' })
  assert.deepEqual(p({ pendingDecisionCount: 2, missingComponentsCount: 5, pulledRowCount: 9 }), { key: 'pending_decision', zh: '等您拿主意 2 件', en: '2 waiting on your decision', tone: 'warning' })
  assert.deepEqual(p({ pendingDecisionCount: 0, missingComponentsCount: 5, pulledRowCount: 9 }), { key: 'blocked', zh: '卡住了:缺件 5 种', en: 'Blocked: 5 missing part(s)', tone: 'danger' })
  assert.deepEqual(p({ pulledRowCount: 1 }), { key: 'ready', zh: '可以导出', en: 'Ready to export', tone: 'success' })
  assert.deepEqual(p({}), { key: 'not_pulled', zh: '还没拉过', en: 'Not pulled yet', tone: 'neutral' })
  assert.deepEqual(p({ pulledRowCount: -3, pendingDecisionCount: -1 }), p({}), 'negative counts read as zero')
})

// ── O-03 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-03 the deep link is two encoded handles or null', () => {
  assert.equal(overview.buildProjectOverviewDeepLink({ sheetId: 'sheet a', todoViewId: 'view/1' }), '/multitable/sheet%20a/view%2F1')
  assert.equal(overview.buildProjectOverviewDeepLink({ sheetId: 'sheet_x', todoViewId: null }), null)
  assert.equal(overview.buildProjectOverviewDeepLink({ sheetId: '', todoViewId: 'v' }), null)
  assert.equal(overview.buildProjectOverviewDeepLink(), null)
})

// ── O-04 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-04 switch OFF: the four routes are 404 DISABLED with zero IO; the gate refuses first', async () => {
  const h = mount({ switchOn: false })
  try {
    h.seedRegistryRow(PROJECT)
    for (const [label, run] of [['get', () => getFields(h, FLOOR)], ['patch', () => patchFields(h, FLOOR, { note: NOTE })], ['refresh', () => refresh(h, FLOOR)], ['ensure', () => ensure(h, PULLER)]]) {
      const res = await run()
      assert.equal(res.statusCode, 404, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED')
      // Fix round 2 (F6): LITERALLY zero IO — not even the operator scope's tenant-membership lookup, so a
      // switch check moved below the scope resolution goes red here, route by route.
      assert.deepEqual(h.tenantDirectoryCalls, [], `${label}: no operator-scope / tenant-membership lookup`)
    }
    assert.deepEqual(h.db.calls, [], 'no registry statement')
    assert.deepEqual(h.provisioning.calls, [], 'no host call')
    assert.deepEqual(h.records.calls, [], 'no records call')
    assert.deepEqual(h.auditAppends, [])
    for (const run of [() => getFields(h, READ_ONLY), () => patchFields(h, READ_ONLY, { note: NOTE }), () => refresh(h, READ_ONLY), () => ensure(h, FLOOR)]) {
      const res = await run()
      assert.equal(res.statusCode, 403, JSON.stringify(res.body))
    }
    assert.deepEqual(h.db.calls, [])
    assert.deepEqual(h.tenantDirectoryCalls, [])
    // Control (the harness CAN see the lookup): with the switch ON the same refresh resolves the operator scope.
    const on = mount()
    try {
      await refresh(on, FLOOR)
      assert.ok(on.tenantDirectoryCalls.length >= 1, 'switch on: the scope lookup is observable')
    } finally { on.restore() }
    // Fix round 1 (R9): the update verb is PATCH; there is no PUT route any more.
    assert.equal(h.routes.has(`PUT ${FIELDS_PATH}`), false)
    assert.equal(h.routes.has(`PATCH ${FIELDS_PATH}`), true)
  } finally { h.restore() }
})

// ── O-05 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-05 project fields: the closed whitelist, the caps, the calendar day, absent and archived — before any write, values-free', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    const unknown = await patchFields(h, FLOOR, { note: NOTE, owner: 'x' })
    assert.equal(unknown.statusCode, 400, JSON.stringify(unknown.body))
    assert.equal(unknown.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_REQUEST_INVALID')
    const cases = [
      [{ responsibleLabel: 'x'.repeat(PROJECT_FIELD_TEXT_LIMITS.responsibleLabel + 1) }, 'responsibleLabel'],
      [{ note: 'y'.repeat(PROJECT_FIELD_TEXT_LIMITS.note + 1) }, 'note'],
      [{ plannedFinishOn: '2026-13-01' }, 'plannedFinishOn'],
      [{ plannedFinishOn: '2026-02-30' }, 'plannedFinishOn'],
      [{ plannedFinishOn: '2026-12-24T00:00:00Z' }, 'plannedFinishOn'],
      // Fix round 1 (R2): year 0000 (and so any year below 1) is not a storable day.
      [{ plannedFinishOn: '0000-01-01' }, 'plannedFinishOn'],
      [{ plannedFinishOn: '0000-02-29' }, 'plannedFinishOn'],
      [{ note: 42 }, 'note'],
      [{}, 'body'],
    ]
    for (const [body, field] of cases) {
      const res = await patchFields(h, FLOOR, body)
      assert.equal(res.statusCode, 422, `${JSON.stringify(body).slice(0, 40)}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_FIELDS_INVALID')
      assert.equal(res.body.error.details.field, field)
      const serialized = JSON.stringify(res.body)
      assert.ok(!serialized.includes('xxxxx') && !serialized.includes('yyyyy') && !serialized.includes('2026-13') && !serialized.includes('2026-02-30') && !serialized.includes('0000-0'), 'the refusal never echoes the value')
    }
    // Year 0001 IS a day.
    const yearOne = await patchFields(h, FLOOR, { plannedFinishOn: '0001-01-01' })
    assert.equal(yearOne.statusCode, 200, JSON.stringify(yearOne.body))
    assert.equal(yearOne.body.data.fields.plannedFinishOn, '0001-01-01')
    assert.equal((await patchFields(h, FLOOR, { plannedFinishOn: null })).statusCode, 200)
    h.auditAppends.length = 0
    h.db.calls.length = 0
    // Absent (another project) and archived.
    const absent = await patchFields(h, FLOOR, { note: NOTE }, 'PRJ-S3-NOPE')
    assert.equal(absent.statusCode, 409)
    assert.equal(absent.body.error.code, 'STOCK_PREPARATION_PROJECT_ABSENT')
    h.seedRegistryRow(PROJECT_B, { archived: true })
    const archived = await patchFields(h, FLOOR, { note: NOTE }, PROJECT_B)
    assert.equal(archived.statusCode, 409, JSON.stringify(archived.body))
    assert.equal(archived.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
    assert.ok(!h.db.calls.some((c) => c.startsWith('updateRow')), 'an archived project is refused without an update statement')
    assert.deepEqual(h.auditAppends, [])
    assert.equal(registryRow(h, PROJECT_B).note, undefined)
    // The GET on an archived project still answers (read-only), with may.update false.
    const archivedGet = await getFields(h, FLOOR, PROJECT_B)
    assert.equal(archivedGet.statusCode, 200)
    assert.deepEqual(archivedGet.body.data.may, { update: false })
    assert.equal(archivedGet.body.data.status, 'archived')
    // The GET on an absent project: status absent, fields null.
    const absentGet = await getFields(h, FLOOR, 'PRJ-S3-NOPE')
    assert.equal(absentGet.statusCode, 200)
    assert.deepEqual(absentGet.body.data, { projectNo: 'PRJ-S3-NOPE', status: 'absent', fields: null, updatedAt: null, may: { update: false } })
  } finally { h.restore() }
})

// ── O-06 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-06 project fields: the write is locked + compare-and-set, the GET reads it back, the audit names columns only, no other surface carries the texts', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    const res = await patchFields(h, FLOOR, { responsibleLabel: ` ${RESPONSIBLE} `, note: NOTE, plannedFinishOn: DAY })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.data.fields, { responsibleLabel: RESPONSIBLE, note: NOTE, plannedFinishOn: DAY })
    assert.deepEqual(res.body.data.changed, ['responsibleLabel', 'note', 'plannedFinishOn'])
    assert.equal(res.body.data.status, 'active')
    assert.deepEqual(res.body.data.may, { update: true })
    assert.ok(typeof res.body.data.updatedAt === 'string')
    // Order: transaction → the tenant lock → FOR UPDATE → the compare-and-set update. (No overview exists
    // yet, so the per-event row update after it is a lookup and nothing else.)
    const writes = h.db.calls.filter((c) => /^(transaction|advisoryXactLock|selectOneForUpdate|updateRow)/.test(c))
    assert.deepEqual(writes, ['transaction', `advisoryXactLock:stock-prep-project-target:${TENANT}`, 'selectOneForUpdate:integration_stock_prep_project_target', 'updateRow:integration_stock_prep_project_target'])
    const row = registryRow(h)
    assert.equal(row.responsible_label, RESPONSIBLE)
    assert.equal(row.note, NOTE)
    assert.equal(row.planned_finish_on, DAY)
    assert.equal(row.project_fields_updated_by, FLOOR.id)
    assert.equal(row.status, 'active')
    // The audit row: the action, the sheet handle, a count map of column NAMES — never a value.
    assert.deepEqual(h.auditAppends.map((e) => [e.action, e.mode, e.projectId, e.subjectId]), [['project_fields_update', 'updated', PROJECT, row.sheet_id]])
    assert.deepEqual(h.auditAppends[0].detail, { updatedFieldCount: 3, fields: { responsibleLabel: 1, note: 1, plannedFinishOn: 1 } })
    for (const append of h.auditAppends) {
      const serialized = JSON.stringify(append)
      for (const forbidden of [RESPONSIBLE, NOTE, DAY]) assert.ok(!serialized.includes(forbidden), `audit must not carry ${forbidden}`)
    }
    // The GET reads it back; the GET target and the list never carry the texts.
    const read = await getFields(h, FLOOR)
    assert.deepEqual(read.body.data.fields, { responsibleLabel: RESPONSIBLE, note: NOTE, plannedFinishOn: DAY })
    for (const surface of [await getTarget(h, FLOOR), await listTargets(h, FLOOR)]) {
      const serialized = JSON.stringify(surface.body)
      for (const forbidden of [RESPONSIBLE, NOTE, DAY]) assert.ok(!serialized.includes(forbidden), `${forbidden} must not leave the project-fields routes`)
    }
    // A partial patch changes exactly its keys; '' and null clear.
    const partial = await patchFields(h, FLOOR, { note: '' })
    assert.equal(partial.statusCode, 200)
    assert.deepEqual(partial.body.data.changed, ['note'])
    assert.deepEqual(partial.body.data.fields, { responsibleLabel: RESPONSIBLE, note: null, plannedFinishOn: DAY })
    const cleared = await patchFields(h, WORKBENCH_ADMIN, { plannedFinishOn: null })
    assert.equal(cleared.statusCode, 200)
    assert.deepEqual(cleared.body.data.fields, { responsibleLabel: RESPONSIBLE, note: null, plannedFinishOn: null })
    assert.deepEqual(h.auditAppends.slice(1).map((e) => e.detail), [{ updatedFieldCount: 1, fields: { note: 1 } }, { updatedFieldCount: 1, fields: { plannedFinishOn: 1 } }])
  } finally { h.restore() }
})

// ── O-07 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-07 (R6) only the PULL tier creates the overview — once, stamped, with its views and the G1 READ grant; the refresh never creates and is cooled down', async () => {
  const h = mount({ grantRoleIds: ['stock-prep_frontline', 'stock-prep_puller'] })
  try {
    // The OPERATE refresh never provisions: no overview → 409 ABSENT, nothing written, nothing audited.
    const early = await refresh(h, FLOOR)
    assert.equal(early.statusCode, 409, JSON.stringify(early.body))
    assert.equal(early.body.error.code, 'STOCK_PREPARATION_PROJECT_OVERVIEW_ABSENT')
    assert.deepEqual(hostWrites(h), [])
    assert.deepEqual(h.records.calls, [])
    assert.deepEqual(h.auditAppends, [])
    // …and the floor cannot ensure it (PULL tier), at no cost.
    h.provisioning.calls.length = 0
    assert.equal((await ensure(h, FLOOR)).statusCode, 403)
    assert.deepEqual(h.provisioning.calls, [])

    const first = await ensure(h, PULLER)
    assert.equal(first.statusCode, 200, JSON.stringify(first.body))
    assert.equal(first.body.data.created, true)
    assert.equal(first.body.data.sheetId, overviewSheetId(h))
    assert.equal(first.body.data.activeViewId, `view_${OVERVIEW_OBJECT.slice(-8)}_overview-active`)
    assert.equal(first.body.data.archivedViewId, `view_${OVERVIEW_OBJECT.slice(-8)}_overview-archived`)
    assert.deepEqual(first.body.data.grant, { attempted: true, skipped: null, roleCount: 2, granted: 2, alreadyGranted: 0 })
    assert.deepEqual(hostWrites(h).map((c) => c.slice(0, 2)), [['ensureObject', OVERVIEW_OBJECT], ['ensureView', 'overview-active'], ['ensureView', 'overview-archived'], ['grantOverviewRoleRead', overviewSheetId(h)]])
    // The lookup came FIRST (R8b) — before the ensure wrote anything.
    assert.deepEqual(h.provisioning.calls[0], ['findObjectSheet', OVERVIEW_OBJECT])
    const object = h.provisioning.objects.get(`${STAGING}/${OVERVIEW_OBJECT}`)
    assert.equal(object.systemKind, KIND, 'the host was asked to stamp the overview kind')
    assert.deepEqual([...object.fields.keys()], [...overview.STOCK_PREPARATION_PROJECT_OVERVIEW_FIELD_IDS])
    // G1 READ: the configured roles, the overview object, the plugin's own staging project — nothing from the request.
    assert.deepEqual(h.provisioning.overviewGrantCalls.map((c) => [c.projectId, c.sheetId, c.objectId, c.roleIds, c.actorId]), [[STAGING, overviewSheetId(h), OVERVIEW_OBJECT, ['stock-prep_frontline', 'stock-prep_puller'], PULLER.id]])
    assert.deepEqual(h.auditAppends.map((e) => [e.action, e.mode, e.subjectId, e.projectId ?? null]), [
      ['project_overview_refresh', 'sheet_created', overviewSheetId(h), null],
      ['project_target_grant', 'overview_read_granted', overviewSheetId(h), null],
    ])
    assert.deepEqual(h.auditAppends[1].detail, { roleCount: 2, granted: 2, alreadyGranted: 0 })
    // The list hands the home page the STAMPED overview's handles.
    const list = await listTargets(h)
    assert.deepEqual(list.body.data.overview, { status: 'ready', sheetId: overviewSheetId(h), activeViewId: first.body.data.activeViewId, archivedViewId: first.body.data.archivedViewId })
    // A second ensure writes no sheet and no view; the grant re-runs (heals) and adds nothing.
    h.provisioning.calls.length = 0
    const second = await ensure(h, WORKBENCH_ADMIN)
    assert.equal(second.statusCode, 200)
    assert.equal(second.body.data.created, false)
    assert.deepEqual(hostWrites(h).map((c) => c[0]), ['grantOverviewRoleRead'])
    assert.equal(h.auditAppends[2].mode, 'overview_read_already_granted')

    // THE REFRESH projects into it; a second click inside the cooldown is 200 fresh:false with NO refresh IO.
    const r1 = await refresh(h, FLOOR)
    assert.equal(r1.statusCode, 200, JSON.stringify(r1.body))
    assert.equal(r1.body.data.fresh, true)
    assert.equal(r1.body.data.sheetId, overviewSheetId(h))
    assert.equal(h.auditAppends.at(-1).mode, 'refreshed')
    const audits = h.auditAppends.length
    const dbCalls = h.db.calls.length
    const hostCalls = h.provisioning.calls.length
    const recordCalls = h.records.calls.length
    const cooled = await refresh(h, FLOOR)
    assert.equal(cooled.statusCode, 200)
    assert.deepEqual(Object.keys(cooled.body.data).sort(), ['cooldownSeconds', 'fresh', 'retryAfterSeconds'])
    assert.equal(cooled.body.data.fresh, false)
    assert.equal(cooled.body.data.cooldownSeconds, 60)
    assert.ok(cooled.body.data.retryAfterSeconds >= 1 && cooled.body.data.retryAfterSeconds <= 60)
    assert.deepEqual([h.auditAppends.length, h.db.calls.length, h.provisioning.calls.length, h.records.calls.length], [audits, dbCalls, hostCalls, recordCalls], 'inside the cooldown: no registry, host, records or audit work')
    passCooldown()
    const r2 = await refresh(h, FLOOR)
    assert.equal(r2.body.data.fresh, true)
    assert.deepEqual(hostWrites(h).filter((c) => c[0] === 'ensureObject' || c[0] === 'ensureView'), [], 'the refresh never provisions')
  } finally { h.restore() }
})

test('O-07b (R6) the project-target create ensures the overview when it is absent (best-effort) and writes the project\'s row', async () => {
  const h = mount({ grantRoleIds: ['stock-prep_frontline'] })
  try {
    const created = await createTarget(h, PULLER)
    assert.equal(created.statusCode, 201, JSON.stringify(created.body))
    assert.deepEqual(created.body.data.overview, { ensured: true, created: true, code: null })
    assert.equal(h.provisioning.objects.get(`${STAGING}/${OVERVIEW_OBJECT}`).systemKind, KIND)
    assert.equal(overviewRows(h).length, 1, 'the new project\'s row is written at once')
    assert.equal(logical(overviewRows(h)[0], 'projectNo'), PROJECT)
    assert.deepEqual(h.auditAppends.map((e) => [e.action, e.mode]), [
      ['project_target_create', 'sheet_created'],
      ['project_target_grant', 'granted'],
      ['project_overview_refresh', 'sheet_created'],
      ['project_target_grant', 'overview_read_granted'],
    ])
    // A second project: the overview exists, so it is not re-created; its row joins.
    const second = await createTarget(h, PULLER, PROJECT_B)
    assert.equal(second.statusCode, 201)
    assert.deepEqual(second.body.data.overview, { ensured: true, created: false, code: null })
    assert.deepEqual(overviewRows(h).map((row) => logical(row, 'projectNo')).sort(), [PROJECT, PROJECT_B])
  } finally { h.restore() }
  // On an OLDER host the overview leg refuses before any IO and the create still answers 201.
  const old = mount({ stampsSystemKind: false })
  try {
    const created = await createTarget(old, PULLER)
    assert.equal(created.statusCode, 201, JSON.stringify(created.body))
    assert.deepEqual(created.body.data.overview, { ensured: false, created: false, code: 'STOCK_PREPARATION_PROJECT_OVERVIEW_HOST_UNSUPPORTED' })
    assert.ok(!old.provisioning.calls.some((c) => c[1] === OVERVIEW_OBJECT), 'no host call names the overview')
  } finally { old.restore() }
})

// ── O-08 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-08 (R8) fail-closed on the stamp: an older host is 503 before ANY IO; an unstamped sheet at the derived id is 409 with nothing created; the list issues no handle for it', async () => {
  // (a) An older host: no stamp declaration → 503 before any host call, on ensure AND refresh.
  const old = mount({ stampsSystemKind: false })
  try {
    for (const run of [() => ensure(old, PULLER), () => refresh(old, FLOOR)]) {
      const res = await run()
      assert.equal(res.statusCode, 503, JSON.stringify(res.body))
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_OVERVIEW_HOST_UNSUPPORTED')
    }
    assert.deepEqual(old.provisioning.calls, [], 'no host call at all')
    assert.deepEqual(old.records.calls, [])
    assert.deepEqual(old.auditAppends, [])
  } finally { old.restore() }

  // (b) An UNSTAMPED sheet already at the derived id (made before the reservation, or by an older host).
  const h = mount()
  try {
    projectSheet.seedObject(h.provisioning, STAGING, OVERVIEW_OBJECT)
    const res = await ensure(h, PULLER)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_OVERVIEW_NOT_STAMPED')
    assert.deepEqual({ ...res.body.error.details }, { objectId: OVERVIEW_OBJECT, mode: 'existing', reportedKind: 'none' })
    assert.deepEqual(hostWrites(h), [], 'nothing created, no field written onto it, no grant')
    assert.deepEqual(h.auditAppends, [])
    const list = await listTargets(h)
    assert.deepEqual(list.body.data.overview, { status: 'not_stamped', sheetId: null, activeViewId: null, archivedViewId: null }, 'no handle for a sheet the plugin refuses')
    const r = await refresh(h, FLOOR)
    assert.equal(r.statusCode, 409)
    assert.equal(r.body.error.code, 'STOCK_PREPARATION_PROJECT_OVERVIEW_NOT_STAMPED')
    assert.deepEqual(h.records.calls, [])
    // A sheet reporting SOME OTHER kind is refused the same way.
    h.provisioning.objects.get(`${STAGING}/${OVERVIEW_OBJECT}`).systemKind = 'people_directory'
    const other = await ensure(h, PULLER)
    assert.equal(other.statusCode, 409)
    assert.equal(other.body.error.details.reportedKind, 'other')
  } finally { h.restore() }

  // (c) The race the lookup cannot see: the HOST refuses to adopt inside its transaction → the same 409.
  const raced = mount()
  try {
    raced.provisioning.ensureObject = async () => { throw Object.assign(new Error('A sheet already exists at this id without the requested system kind; it is not adopted'), { status: 409, code: 'SHEET_SYSTEM_KIND_CONFLICT' }) }
    const res = await ensure(raced, PULLER)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_OVERVIEW_NOT_STAMPED')
    assert.deepEqual(raced.auditAppends, [])
  } finally { raced.restore() }

  // (d) A host that creates WITHOUT stamping (declares, then does not) is refused at the read-back.
  const liar = mount()
  try {
    const realEnsure = liar.provisioning.ensureObject
    liar.provisioning.ensureObject = async (input) => realEnsure({ ...input, systemKind: undefined })
    const res = await ensure(liar, PULLER)
    assert.equal(res.statusCode, 409)
    assert.deepEqual({ ...res.body.error.details }, { objectId: OVERVIEW_OBJECT, mode: 'created', reportedKind: 'none' })
    assert.ok(!liar.provisioning.calls.some((c) => c[0] === 'ensureView'), 'no view on an unstamped sheet')
  } finally { liar.restore() }

  // (e) A host that answers WITHOUT the systemKind key at all, and (E2) a database without the column.
  const silent = mount()
  try {
    projectSheet.seedObject(silent.provisioning, STAGING, OVERVIEW_OBJECT)
    const realFind = silent.provisioning.findObjectSheet
    silent.provisioning.findObjectSheet = async (input) => {
      const found = await realFind(input)
      if (!found) return found
      const { systemKind, ...rest } = found
      return rest
    }
    const res = await ensure(silent, PULLER)
    assert.equal(res.statusCode, 503, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_OVERVIEW_HOST_UNSUPPORTED')
  } finally { silent.restore() }
  const columnless = mount()
  try {
    columnless.provisioning.ensureObject = async () => { throw Object.assign(new Error('column "system_kind" of relation "meta_sheets" does not exist'), { code: '42703' }) }
    const res = await ensure(columnless, PULLER)
    assert.equal(res.statusCode, 503, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_OVERVIEW_HOST_UNSUPPORTED')
    assert.ok(!JSON.stringify(res.body).includes('meta_sheets'), 'the database message is not echoed')
  } finally { columnless.restore() }
})

// ── O-09 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-09 the bounded count of one project sheet: active rule, two open counts, the page bound, degrade', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    seedProjectRows(h, PROJECT, { total: 7, active: 5, procurementDone: 2, warehouseDone: 4 })
    const target = { projectNo: PROJECT, sheetId: h.provisioning.sheetIdOf(STAGING, h.projectObjectId()), objectId: h.projectObjectId() }
    const counts = await overview.countProjectSheetRows({ recordsApi: h.records, provisioning: h.provisioning, projectId: STAGING, row: target })
    assert.deepEqual(counts, { ready: true, bounded: false, rowCount: 7, activeRowCount: 5, procurementOpenCount: 3, warehouseOpenCount: 1 })
    // Another project's rows in the same sheet are NOT counted (the read is narrowed by project number).
    const foreign = { ...target, projectNo: 'PRJ-S3-OTHER' }
    assert.deepEqual(await overview.countProjectSheetRows({ recordsApi: h.records, provisioning: h.provisioning, projectId: STAGING, row: foreign }), { ready: true, bounded: false, rowCount: 0, activeRowCount: 0, procurementOpenCount: 0, warehouseOpenCount: 0 })
    // The bound: a sheet that keeps answering full pages is a floor.
    const full = Array.from({ length: PULL_TARGET_PAGE_LIMIT }, () => ({ data: { [phys(h.projectObjectId(), 'projectNo')]: PROJECT, [phys(h.projectObjectId(), 'active')]: true } }))
    let pages = 0
    const endless = { queryRecords: async () => { pages += 1; return full } }
    const bounded = await overview.countProjectSheetRows({ recordsApi: endless, provisioning: h.provisioning, projectId: STAGING, row: target })
    assert.equal(bounded.bounded, true)
    assert.equal(pages, PULL_TARGET_MAX_PAGES)
    assert.equal(bounded.rowCount, PULL_TARGET_PAGE_LIMIT * PULL_TARGET_MAX_PAGES)
    assert.equal(bounded.procurementOpenCount, bounded.rowCount, 'an active row with no done flag is open')
    // Degrade: a host that throws, or answers a non-array.
    assert.deepEqual(await overview.countProjectSheetRows({ recordsApi: { queryRecords: async () => { throw new Error('down') } }, provisioning: h.provisioning, projectId: STAGING, row: target }), { ready: false })
    assert.deepEqual(await overview.countProjectSheetRows({ recordsApi: { queryRecords: async () => null }, provisioning: h.provisioning, projectId: STAGING, row: target }), { ready: false })
  } finally { h.restore() }
})

// ── O-10 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-10 the projection end to end: one row per registry row, deep link, posture, texts, counts, 截至, registry stamped; (R7) an unchanged refresh writes NOTHING', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    h.seedRegistryRow(PROJECT_B, { archived: true })
    seedProjectRows(h, PROJECT, { total: 4, active: 3, procurementDone: 1, warehouseDone: 3 })
    assert.equal((await patchFields(h, FLOOR, { responsibleLabel: RESPONSIBLE, note: NOTE, plannedFinishOn: DAY })).statusCode, 200)
    assert.equal((await ensure(h, PULLER)).statusCode, 200)
    h.records.calls.length = 0
    const res = await refresh(h, FLOOR)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const summary = res.body.data
    assert.equal(summary.projectCount, 2)
    assert.equal(summary.countedCount, 2)
    assert.equal(summary.rowsCreated, 2)
    assert.equal(summary.ledgerReady, false, 'no ledger on this substrate → pending counts are zero and said so')
    const rows = overviewRows(h)
    assert.equal(rows.length, 2)
    const a = rows.find((row) => logical(row, 'projectNo') === PROJECT)
    const b = rows.find((row) => logical(row, 'projectNo') === PROJECT_B)
    const projectObject = h.projectObjectId()
    const expectedLink = `/multitable/${encodeURIComponent(h.provisioning.sheetIdOf(STAGING, projectObject))}/${encodeURIComponent(h.provisioning.getObjectViewId(STAGING, projectObject, STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID))}`
    assert.equal(logical(a, 'sheetLink'), expectedLink, 'O1: the registry sheet + the host-derived 待填写 view, nothing else')
    assert.equal(logical(a, 'status'), 'active')
    assert.equal(logical(a, 'postureKey'), 'ready')
    assert.equal(logical(a, 'posture'), 'Ready to export', 'the deployment locale is en unless opted in')
    assert.equal(logical(a, 'responsibleLabel'), RESPONSIBLE)
    assert.equal(logical(a, 'note'), NOTE)
    assert.equal(logical(a, 'plannedFinishOn'), DAY)
    assert.equal(logical(a, 'rowCount'), 4)
    assert.equal(logical(a, 'activeRowCount'), 3)
    assert.equal(logical(a, 'countsBounded'), false)
    assert.equal(logical(a, 'procurementOpenCount'), 2)
    assert.equal(logical(a, 'warehouseOpenCount'), 0)
    assert.equal(logical(a, 'pendingDecisionCount'), 0)
    assert.equal(logical(a, 'missingComponentsCount'), 0)
    assert.equal(logical(b, 'status'), 'archived')
    assert.equal(logical(b, 'postureKey'), 'archived')
    assert.equal(logical(b, 'rowCount'), 0)
    assert.equal(logical(b, 'responsibleLabel'), null)
    // The registry's count columns were stamped (they changed: never counted before), and 「截至」 on the
    // row IS the registry's counts_at — the two agree.
    const stamped = registryRow(h)
    assert.equal(stamped.row_count, 4)
    assert.equal(stamped.active_row_count, 3)
    assert.equal(stamped.procurement_open_count, 2)
    assert.equal(stamped.warehouse_open_count, 0)
    assert.equal(stamped.counts_bounded, false)
    assert.ok(stamped.counts_at instanceof Date)
    assert.equal(logical(a, 'countsAt'), stamped.counts_at.toISOString())
    const list = await listTargets(h)
    const item = list.body.data.items.find((i) => i.projectNo === PROJECT)
    assert.deepEqual([item.rowCount, item.activeRowCount, item.procurementOpenCount, item.warehouseOpenCount, item.countsBounded], [4, 3, 2, 0, false])
    // The audit: counts only.
    const audit = h.auditAppends.filter((e) => e.action === 'project_overview_refresh').at(-1)
    assert.deepEqual(audit.detail, { projectCount: 2, countedCount: 2, unreadableCount: 0, boundedCount: 0, rowsCreated: 2, rowsUpdated: 0, rowsUnchanged: 0, rowsRemovedDuplicate: 0, rowsRemovedOrphan: 0, truncated: false, ledgerReady: false })
    for (const forbidden of [RESPONSIBLE, NOTE, DAY]) assert.ok(!JSON.stringify(h.auditAppends).includes(forbidden))

    // R7: a second refresh that MEASURES THE SAME NUMBERS writes nothing — no overview patch, no registry
    // stamp — and 「截至」 stays where it was (the counts did not change after it).
    passCooldown()
    const countsAtBefore = stamped.counts_at
    h.records.calls.length = 0
    h.db.calls.length = 0
    const again = await refresh(h, FLOOR)
    assert.deepEqual([again.body.data.rowsCreated, again.body.data.rowsUpdated, again.body.data.rowsUnchanged], [0, 0, 2])
    assert.ok(!h.records.calls.some((c) => c[0] === 'createRecord' || c[0] === 'patchRecord'), 'R7: nothing written when nothing changed')
    assert.ok(!h.db.calls.some((c) => c.startsWith('updateRow')), 'R7: the registry is not re-stamped either')
    assert.equal(registryRow(h).counts_at, countsAtBefore)
    assert.equal(logical(overviewRows(h).find((row) => logical(row, 'projectNo') === PROJECT), 'countsAt'), countsAtBefore.toISOString())
    // A changed count re-stamps and patches exactly that row, with a new 「截至」.
    seedProjectRows(h, PROJECT, { total: 1, active: 1 })
    passCooldown()
    const changed = await refresh(h, FLOOR)
    assert.deepEqual([changed.body.data.rowsUpdated, changed.body.data.rowsUnchanged], [1, 1])
    const aAfter = overviewRows(h).find((row) => logical(row, 'projectNo') === PROJECT)
    assert.equal(logical(aAfter, 'rowCount'), 5)
    assert.notEqual(logical(aAfter, 'countsAt'), countsAtBefore.toISOString())
    assert.equal(logical(aAfter, 'countsAt'), registryRow(h).counts_at.toISOString())
    // UNREADABLE sheets keep the registry's last stamped counts and 「截至」, and cost no write.
    const realQuery = h.records.queryRecords
    h.records.queryRecords = async (input = {}) => {
      if (input.sheetId !== overviewSheetId(h)) throw new Error('project sheets unreadable')
      return realQuery(input)
    }
    passCooldown()
    h.records.calls.length = 0
    const fourth = await refresh(h, FLOOR)
    assert.equal(fourth.statusCode, 200, JSON.stringify(fourth.body))
    assert.deepEqual([fourth.body.data.countedCount, fourth.body.data.unreadableCount, fourth.body.data.rowsUpdated, fourth.body.data.rowsUnchanged], [0, 2, 0, 2])
    assert.ok(!h.records.calls.some((c) => c[0] === 'createRecord' || c[0] === 'patchRecord'), 'no overview write when nothing changed')
    assert.equal(logical(overviewRows(h).find((row) => logical(row, 'projectNo') === PROJECT), 'rowCount'), 5)
    h.records.queryRecords = realQuery
  } finally { h.restore() }
})

// ── O-11 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-11 last_pull_*: a dry-run stamps previewed, a typed failure stamps refused + code, a stamp failure never fails the pull, switch off stamps nothing; (R10) a code without code shape is UNKNOWN + one values-free warn', async () => {
  const logger = capturingLogger()
  const h = mount({ logger })
  try {
    h.seedRegistryRow(PROJECT)
    const ok = await dryRun(h)
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
    let row = registryRow(h)
    assert.equal(row.last_pull_outcome, 'previewed')
    assert.equal(row.last_pull_code, null)
    assert.ok(row.last_pull_at instanceof Date)
    const list = await listTargets(h)
    assert.equal(list.body.data.items[0].lastPullOutcome, 'previewed')
    // A run that throws a typed refusal: refused + its code, and the refusal still surfaces.
    const realProbe = h.provisioning.resolveExistingObjectFieldIds
    h.provisioning.resolveExistingObjectFieldIds = async () => ({})
    const failed = await dryRun(h)
    assert.equal(failed.statusCode, 422, JSON.stringify(failed.body))
    assert.equal(failed.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
    row = registryRow(h)
    assert.equal(row.last_pull_outcome, 'refused')
    assert.equal(row.last_pull_code, 'TARGET_SCHEMA_INCOMPLETE')
    h.provisioning.resolveExistingObjectFieldIds = realProbe
    // R10: a run that throws with a code WITHOUT error-code shape — recorded as UNKNOWN, the pull's own
    // answer unchanged, ONE warn that carries neither the code nor anything else from the error.
    const realProbeAgain = h.records.queryRecords
    h.records.queryRecords = async () => { throw Object.assign(new Error('host said something with a value in it'), { code: 'weird code: value-42' }) }
    const warnsBefore = logger.warnings.length
    const odd = await dryRun(h)
    assert.notEqual(odd.statusCode, 200)
    assert.equal(registryRow(h).last_pull_outcome, 'refused')
    assert.equal(registryRow(h).last_pull_code, 'UNKNOWN')
    const shapeWarns = logger.warnings.slice(warnsBefore).filter((w) => /without error-code shape/.test(w.message))
    assert.equal(shapeWarns.length, 1)
    assert.ok(!JSON.stringify(shapeWarns).includes('value-42') && !JSON.stringify(shapeWarns).includes('weird'), 'the warn is values-free')
    h.records.queryRecords = realProbeAgain
    // A stamp that cannot be written never fails the pull.
    const realUpdate = h.db.updateRow
    h.db.updateRow = async (table, ...rest) => {
      if (table === 'integration_stock_prep_project_target') throw new Error('registry unreachable')
      return realUpdate(table, ...rest)
    }
    const stillOk = await dryRun(h)
    assert.equal(stillOk.statusCode, 200, JSON.stringify(stillOk.body))
    assert.equal(registryRow(h).last_pull_outcome, 'refused', 'the stamp could not be written; the previous one stands')
    h.db.updateRow = realUpdate
  } finally { h.restore() }
  const off = mount({ switchOn: false })
  try {
    off.seedRegistryRow(PROJECT)
    const res = await dryRun(off)
    assert.ok(!off.db.calls.some((c) => c.startsWith('updateRow')), `switch off: no stamp (got ${res.statusCode})`)
    assert.equal(registryRow(off).last_pull_outcome, undefined)
  } finally { off.restore() }
})

// ── O-12 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-12 the directory enumerates registry rows with the switch on; switch off is byte-identical to S2', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    h.seedRegistryRow(PROJECT_B, { archived: true })
    Object.assign(registryRow(h), { row_count: 12, missing_components_count: 2 })
    const res = await directory(h, FLOOR)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const byNo = new Map(res.body.data.projects.map((p) => [p.projectNo, p]))
    assert.deepEqual([...byNo.keys()].sort(), [PROJECT, PROJECT_B])
    assert.deepEqual([byNo.get(PROJECT).archived, byNo.get(PROJECT).pulledRowCount, byNo.get(PROJECT).missingComponentsCount, byNo.get(PROJECT).sources], [false, 12, 2, ['pull_target']])
    assert.deepEqual([byNo.get(PROJECT_B).archived, byNo.get(PROJECT_B).pulledRowCount, byNo.get(PROJECT_B).missingComponentsCount], [true, null, null])
    assert.equal(res.body.data.pullTargetReady, true)
    assert.equal(res.body.data.fillTarget, null, 'no single fill target with the switch on — each project has its own sheet')
    assert.equal(res.body.data.directoryMayBeIncomplete, false)
  } finally { h.restore() }
  const off = mount({ switchOn: false })
  try {
    off.seedRegistryRow(PROJECT)
    const res = await directory(off, FLOOR)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.data.projects, [], 'switch off: the registry is not read, the env sheet is not bound on this substrate')
    assert.ok(!off.db.calls.some((c) => c.startsWith('select:integration_stock_prep_project_target')), 'switch off: no registry read')
  } finally { off.restore() }
})

// ── O-13 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-13 (S4 carry-over) the replay column probe: a host read failure is 503 TARGET_SCHEMA_UNAVAILABLE; a scope refusal still degrades', async () => {
  const PACK_ID = 's3-synthetic-pack'
  const ENV_OBJECT = 'plm_stock_preparation_sandbox_s3_env'
  const EXT = 'ext_s3Note'
  const h = mount({
    envObjectId: ENV_OBJECT,
    envExtFieldIds: [EXT],
    extensionFieldIds: [EXT],
    packs: { [PACK_ID]: { packId: PACK_ID, packVersion: 1, label: 'S3 synthetic pack', targetObjectId: ENV_OBJECT, extensionFields: [{ id: EXT, label: 'S3 note', type: 'string', ownership: 'human_preserved' }] } },
    ledger: [{ packId: PACK_ID, packVersion: 1 }],
  })
  try {
    const create = await projectSheet.call(h.routes, 'POST', TARGET_PATH, { user: PULLER, params: { projectNo: PROJECT }, body: {} })
    assert.equal(create.statusCode, 201, JSON.stringify(create.body))
    const realProbe = h.provisioning.resolveExistingObjectFieldIds
    h.provisioning.resolveExistingObjectFieldIds = async () => { throw Object.assign(new Error('relation does not exist'), { code: '42P01' }) }
    const replay = await projectSheet.call(h.routes, 'POST', TARGET_PATH, { user: PULLER, params: { projectNo: PROJECT }, body: {} })
    assert.equal(replay.statusCode, 503, JSON.stringify(replay.body))
    assert.equal(replay.body.error.code, 'TARGET_SCHEMA_UNAVAILABLE')
    assert.deepEqual({ ...replay.body.error.details }, { objectId: h.projectObjectId(), packId: PACK_ID })
    assert.ok(!JSON.stringify(replay.body).includes('relation does not exist'), 'the host message is not echoed')
    h.provisioning.resolveExistingObjectFieldIds = async () => { throw Object.assign(new Error('scope'), { name: 'MultitableObjectScopeError' }) }
    const degraded = await projectSheet.call(h.routes, 'POST', TARGET_PATH, { user: PULLER, params: { projectNo: PROJECT }, body: {} })
    assert.equal(degraded.statusCode, 200, JSON.stringify(degraded.body))
    assert.equal(degraded.body.data.customerPacks.alreadyInstalled, 1)
    h.provisioning.resolveExistingObjectFieldIds = realProbe
  } finally { h.restore() }
})

// ── O-14 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-14 (R3) one row per project, always: concurrent refreshes under the overview lock, duplicates and orphans cleaned', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    h.seedRegistryRow(PROJECT_B)
    assert.equal((await ensure(h, PULLER)).statusCode, 200)
    // An overview port whose createRecord YIELDS before it lands — the window a read-then-create race needs.
    const realCreate = h.overviewPort.createRecord
    h.overviewPort.createRecord = async (input) => {
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
      return realCreate(input)
    }
    const run = () => overview.refreshProjectOverview({
      provisioning: h.provisioning,
      recordsApi: h.records,
      store: h.projectTargetStore,
      tenantId: TENANT,
      projectId: STAGING,
    })
    // Fix round 2 (F4): the second concurrent refresh does not WAIT for the lock — it answers 409 BUSY at
    // once, having done nothing; the first one writes exactly one row per project.
    const settled = await Promise.allSettled([run(), run()])
    const done = settled.filter((r) => r.status === 'fulfilled')
    const busy = settled.filter((r) => r.status === 'rejected')
    assert.equal(done.length, 1, JSON.stringify(settled.map((r) => r.status)))
    assert.equal(busy.length, 1)
    assert.equal(busy[0].reason.status, 409)
    assert.equal(busy[0].reason.code, 'STOCK_PREPARATION_PROJECT_OVERVIEW_BUSY')
    assert.deepEqual(overviewRows(h).map((row) => logical(row, 'projectNo')).sort(), [PROJECT, PROJECT_B], 'exactly one row per project')
    assert.equal(done[0].value.rowsCreated, 2)
    assert.equal(h.db.calls.filter((c) => c === `tryAdvisoryXactLock:stock-prep-project-overview:${TENANT}`).length, 1, 'only the running refresh asked the database for the lock')
    assert.equal(h.db.calls.filter((c) => c === `advisoryXactLock:stock-prep-project-overview:${TENANT}`).length, 0, 'nobody BLOCKS on the overview lock')
    h.overviewPort.createRecord = realCreate

    // Pre-existing residue: a duplicate row for one project and a row for a project nobody registered
    // (and one with no project number at all) — the refresh deletes them through the plugin write port.
    const dupe = overviewRows(h).find((row) => logical(row, 'projectNo') === PROJECT)
    h.rows.push({ ...projectSheet.clone(dupe), id: 'rec_dupe' })
    h.rows.push({ id: 'rec_orphan', sheetId: overviewSheetId(h), version: 1, data: { [phys(OVERVIEW_OBJECT, 'projectNo')]: 'PRJ-NOT-REGISTERED' } })
    h.rows.push({ id: 'rec_blank', sheetId: overviewSheetId(h), version: 1, data: {} })
    passCooldown()
    const cleaned = await refresh(h, FLOOR)
    assert.equal(cleaned.statusCode, 200, JSON.stringify(cleaned.body))
    assert.equal(cleaned.body.data.rowsRemovedDuplicate, 1)
    assert.equal(cleaned.body.data.rowsRemovedOrphan, 2)
    assert.deepEqual(overviewRows(h).map((row) => logical(row, 'projectNo')).sort(), [PROJECT, PROJECT_B])
    assert.ok(h.records.calls.filter((c) => c[0] === 'overview.deleteRecord').every((c) => c[1] === overviewSheetId(h)), 'deletes touch the overview sheet only')
    assert.ok(h.records.calls.filter((c) => c[0] === 'overview.deleteRecord').length >= 3, 'the duplicate and orphan deletes went through the overview port')

    // A project that LEAVES the registry has its row removed by the next refresh.
    const rows = h.registryRows()
    rows.splice(rows.findIndex((row) => row.project_no === PROJECT_B), 1)
    passCooldown()
    const pruned = await refresh(h, FLOOR)
    assert.equal(pruned.body.data.rowsRemovedOrphan, 1)
    assert.deepEqual(overviewRows(h).map((row) => logical(row, 'projectNo')), [PROJECT])
  } finally { h.restore() }
})

// ── O-15 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-15 (R5) per-event: create, archive, restore, project fields and the dry-run outcome update THAT project\'s row at once — no refresh', async () => {
  const h = mount()
  try {
    assert.equal((await createTarget(h, PULLER)).statusCode, 201)
    const rowOf = () => overviewRows(h).filter((row) => logical(row, 'projectNo') === PROJECT)
    assert.equal(rowOf().length, 1)
    assert.equal(logical(rowOf()[0], 'status'), 'active')
    // archive → 已归档 now
    assert.equal((await archive(h)).statusCode, 200)
    assert.equal(rowOf().length, 1)
    assert.equal(logical(rowOf()[0], 'status'), 'archived')
    assert.equal(logical(rowOf()[0], 'postureKey'), 'archived')
    assert.equal(logical(rowOf()[0], 'posture'), 'Archived')
    // restore → back to active
    assert.equal((await restore(h)).statusCode, 200)
    assert.equal(logical(rowOf()[0], 'status'), 'active')
    // project fields → the texts
    assert.equal((await patchFields(h, FLOOR, { note: NOTE, plannedFinishOn: DAY })).statusCode, 200)
    assert.equal(logical(rowOf()[0], 'note'), NOTE)
    assert.equal(logical(rowOf()[0], 'plannedFinishOn'), DAY)
    // dry-run outcome → the last pull + a recount
    assert.equal((await dryRun(h)).statusCode, 200)
    assert.equal(logical(rowOf()[0], 'lastPullOutcome'), 'previewed')
    assert.equal(rowOf().length, 1, 'every event patched the same single row')
    assert.equal(h.auditAppends.filter((e) => e.action === 'project_overview_refresh' && e.mode === 'refreshed').length, 0, 'none of it needed a refresh')
  } finally { h.restore() }
})

test('O-15b (R5) the event still answers as before when the overview update throws; the warn carries a code only', async () => {
  const logger = capturingLogger()
  const h = mount({ logger })
  try {
    assert.equal((await createTarget(h, PULLER)).statusCode, 201)
    // Every overview write now fails.
    const failing = async () => { throw Object.assign(new Error('overview write failed for PRJ-S3-O1 with a value'), { code: 'SYNTHETIC_OVERVIEW_DOWN' }) }
    h.overviewPort.patchRecord = failing
    h.overviewPort.createRecord = failing
    const warnsBefore = logger.warnings.length
    const archived = await archive(h)
    assert.equal(archived.statusCode, 200, JSON.stringify(archived.body))
    assert.equal(registryRow(h).status, 'archived', 'the archive itself happened')
    // Restoring changes nothing the (stale) overview row does not already say, so it writes nothing.
    const restored = await restore(h)
    assert.equal(restored.statusCode, 200)
    const fields = await patchFields(h, PULLER, { note: NOTE })
    assert.equal(fields.statusCode, 200, JSON.stringify(fields.body))
    assert.equal(registryRow(h).note, NOTE, 'the fields update itself happened')
    const warns = logger.warnings.slice(warnsBefore).filter((w) => /overview row could not be updated/.test(w.message))
    assert.equal(warns.length, 2)
    for (const w of warns) {
      assert.deepEqual(w.meta, { code: 'SYNTHETIC_OVERVIEW_DOWN' })
      assert.ok(!JSON.stringify(w).includes(PROJECT) && !JSON.stringify(w).includes('with a value'), 'values-free')
    }
    // A thrown error WITHOUT code shape is logged as UNKNOWN.
    h.overviewPort.patchRecord = async () => { throw new Error('no code here') }
    assert.equal((await archive(h)).statusCode, 200)
    assert.deepEqual(logger.warnings.at(-1).meta, { code: 'UNKNOWN' })
  } finally { h.restore() }
})

test('O-15c (R5) the confirmation confirm updates its project\'s row (pending count) on a real ledger fake', async () => {
  const fakes = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))
  const { OBJECT_ID: LEDGER_OBJECT, FIRST_CUT_CONFLICT_TYPE, STATUSES, RESOLUTION_ACTIONS } = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
  const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
  const { createStockPreparationProjectTargetStore } = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
  const LEDGER_SHEET = fakes.derivedSheetId ? fakes.derivedSheetId(STAGING, LEDGER_OBJECT) : 'sheet_ledger_s3'
  const OVERVIEW_SHEET = 'sheet_overview_s3'
  const ledgerRow = fakes.physicalRow(STAGING, LEDGER_OBJECT, {
    decisionId: 'decision_s3_1', projectNo: PROJECT, conflictType: FIRST_CUT_CONFLICT_TYPE, status: STATUSES.PENDING,
    inputFingerprint: 'sha16:0123456789abcdef', sourceRevision: 'rev-1',
  }, 'rec_ledger_1')
  ledgerRow.sheetId = LEDGER_SHEET
  const base = fakes.makeFakeProvisioning({ stagingProjectId: STAGING, sheetIdByObjectId: { [LEDGER_OBJECT]: LEDGER_SHEET, [OVERVIEW_OBJECT]: OVERVIEW_SHEET } })
  const provisioning = {
    ...base,
    supportsSystemKindStamp: true,
    async findObjectSheet(input) {
      const found = await base.findObjectSheet(input)
      if (!found) return found
      return { ...found, systemKind: input.objectId === OVERVIEW_OBJECT ? KIND : null }
    },
    async ensureObject() { throw new Error('unexpected provisioning write') },
    getFieldId: (projectId, objectId, fieldId) => fakes.physicalFieldId(projectId, objectId, fieldId),
    getObjectViewId: (projectId, objectId, viewId) => `view_${objectId.slice(-6)}_${viewId}`,
  }
  const records = fakes.makeStrictRecordsApi({ stagingProjectId: STAGING, objectIdBySheetId: { [LEDGER_SHEET]: LEDGER_OBJECT, [OVERVIEW_SHEET]: OVERVIEW_OBJECT }, rowsBySheet: { [LEDGER_SHEET]: [ledgerRow], [OVERVIEW_SHEET]: [] } })
  records.deleteRecord = async () => { throw new Error('unexpected delete') }
  // Fix round 2 (F3): the overview is written only through the host's overview port (project → derived sheet).
  records.stockPreparationOverview = {
    async createRecord({ projectId, data }) { assert.equal(projectId, STAGING); return records.createRecord({ sheetId: OVERVIEW_SHEET, data }) },
    async patchRecord({ projectId, recordId, changes }) { assert.equal(projectId, STAGING); return records.patchRecord({ sheetId: OVERVIEW_SHEET, recordId, changes }) },
    async deleteRecord() { throw new Error('unexpected delete') },
  }
  const db = projectSheet.makeMemoryDb()
  const store = createStockPreparationProjectTargetStore({ db, idGenerator: () => 'pt-1' })
  db.rowsOf('integration_stock_prep_project_target').push({
    id: 'seed', tenant_id: TENANT, project_no: PROJECT, sheet_id: 'sheet_project_s3', object_id: 'plm_stock_preparation_sandbox_p_0123456789abcdef01234567',
    status: 'active', created_by: 'seed', created_at: new Date('2026-10-08T00:00:00Z'), archived_at: null, updated_at: new Date('2026-10-08T00:00:00Z'),
  })
  const routes = new Map()
  const previous = process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED
  process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED = 'true'
  try {
    httpRoutes.registerIntegrationRoutes({
      context: { api: { http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } }, multitable: { provisioning, records } }, storage: new Map(), config: {} },
      services: {
        // The services registerIntegrationRoutes requires, inert: this test drives the confirm only.
        ...Object.fromEntries(['externalSystemRegistry', 'adapterRegistry', 'pipelineRegistry', 'pipelineRunner', 'deadLetterStore', 'stagingInstaller', 'templateRegistry', 'readSourceConfigStore', 'readSourceCompositionConfigStore', 'bridgeAgentChecklistStore']
          .map((name) => [name, new Proxy({}, { get: (_target, method) => async () => { throw new Error(`unexpected ${name}.${String(method)}`) } })])),
        stockPreparationAuditStore: { async append() { return { ok: true } } },
        stockPreparationProjectTargetStore: store,
        tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
      },
      logger: { info() {}, warn() {}, error() {} },
    })
    const res = await projectSheet.call(routes, 'POST', '/api/integration/stock-preparation/confirmation-decisions/confirm', {
      user: FLOOR,
      body: { decisionId: 'decision_s3_1', inputFingerprint: 'sha16:0123456789abcdef', resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS },
    })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const overviewRowsNow = records.rows(OVERVIEW_SHEET)
    assert.equal(overviewRowsNow.length, 1, 'the confirm wrote its project\'s overview row')
    const read = (key) => overviewRowsNow[0].data[fakes.physicalFieldId(STAGING, OVERVIEW_OBJECT, key)]
    assert.equal(read('projectNo'), PROJECT)
    assert.equal(read('pendingDecisionCount'), 0, 'the confirmed decision is no longer pending')
  } finally {
    if (previous === undefined) delete process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED
    else process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED = previous
  }
})

// ── O-16 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-16 (R2) planned_finish_on reads back as the calendar day it holds on a UTC+ host — no UTC round trip', () => {
  const { execFileSync } = require('node:child_process')
  const storePath = path.join(LIB, 'stock-preparation-project-target-store.cjs')
  // IN THIS PROCESS first (Node re-reads TZ when it is assigned), so the module under test is the very one
  // this suite loaded: a DATE parsed as Asia/Shanghai local midnight reads back as the stored day.
  const { __internals: storeInternals } = require(storePath)
  const previousTz = process.env.TZ
  try {
    for (const tz of ['Asia/Shanghai', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
      process.env.TZ = tz
      const localMidnight = new Date(2026, 11, 24)
      assert.equal(storeInternals.dayOrNull(localMidnight), '2026-12-24', `${tz} (in-process): the stored day, not its UTC shadow ${localMidnight.toISOString()}`)
    }
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
  // …and in a FRESH process started in each zone (no state carried over from this one).
  // In a process whose local zone is Asia/Shanghai, node-postgres parses DATE '2026-12-24' as LOCAL
  // midnight — 2026-12-23T16:00Z. The old toISOString() read handed back the day BEFORE.
  const script = [
    `const store = require(${JSON.stringify(storePath)})`,
    `const d = new Date(2026, 11, 24)`,
    `const e = new Date(1, 0, 1); e.setFullYear(1)`,
    `process.stdout.write(JSON.stringify({ iso: d.toISOString(), day: store.__internals.dayOrNull(d), yearOne: store.__internals.dayOrNull(e), text: store.__internals.dayOrNull('2026-12-24'), infinity: store.__internals.dayOrNull(Infinity), junk: store.__internals.dayOrNull('2026-12-24T00:00:00Z') }))`,
  ].join(';')
  for (const tz of ['Asia/Shanghai', 'Pacific/Kiritimati', 'America/Los_Angeles', 'UTC']) {
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }))
    assert.equal(out.day, '2026-12-24', `${tz}: the stored day, not its UTC shadow (local midnight was ${out.iso})`)
    assert.equal(out.yearOne, '0001-01-01', `${tz}: year 0001 is padded, not 1901`)
    assert.equal(out.text, '2026-12-24')
    assert.equal(out.infinity, null)
    assert.equal(out.junk, null, 'a non-day string reads as null, never as a guessed prefix')
    if (tz === 'Asia/Shanghai') assert.equal(out.iso.slice(0, 10), '2026-12-23', 'the premise: the UTC slice IS the wrong day here')
  }
})

// ── O-17 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-17 (R13) the free texts refuse control characters and NUL — a typed 400 naming the field, never the value', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    const bad = [
      ['responsibleLabel', 'A\u0000B'],
      ['responsibleLabel', 'line\nbreak'],
      ['note', 'tab\tinside'],
      ['note', 'trailing newline\n'],
      ['note', 'bell\u0007'],
      ['note', 'del\u007f'],
      ['note', 'c1\u0085'],
      ['note', 'sep\u2028arator'],
    ]
    for (const [field, value] of bad) {
      const res = await patchFields(h, FLOOR, { [field]: value })
      assert.equal(res.statusCode, 400, `${field} ${JSON.stringify(value)}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_FIELDS_INVALID')
      assert.deepEqual({ ...res.body.error.details }, { field, reason: 'control_character' })
      assert.ok(!JSON.stringify(res.body).includes(value.replace(/[\u0000-\u001f\u007f-\u009f\u2028]/g, '')), 'the value is not echoed')
    }
    assert.ok(!h.db.calls.some((c) => c.startsWith('updateRow')), 'no write for a refused text')
    assert.deepEqual(h.auditAppends, [])
    // Ordinary text — CJK, punctuation, spaces — passes; the caps still apply (422).
    const ok = await patchFields(h, FLOOR, { responsibleLabel: '张三（采购）', note: '先到 A 区；再到 B 区！' })
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
    const long = await patchFields(h, FLOOR, { responsibleLabel: '长'.repeat(PROJECT_FIELD_TEXT_LIMITS.responsibleLabel + 1) })
    assert.equal(long.statusCode, 422)
  } finally { h.restore() }
})

// ── O-18 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-18 (E2) the S3 routes never echo a database message or a submitted value: an unknown error is a fixed 500, a column-less database a typed 503', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    const secret = '负责人-私密值'
    const realTransaction = h.db.transaction
    h.db.transaction = async () => { throw Object.assign(new Error(`invalid input syntax for type date: "${secret}"`), { code: '22007' }) }
    const res = await patchFields(h, FLOOR, { responsibleLabel: secret })
    assert.equal(res.statusCode, 500, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_ROUTE_FAILED')
    assert.ok(!JSON.stringify(res.body).includes(secret), 'the submitted value is not echoed')
    assert.ok(!JSON.stringify(res.body).includes('invalid input syntax'), 'the database message is not echoed')
    h.db.transaction = realTransaction
    const realSelect = h.db.selectOne
    h.db.selectOne = async () => { throw Object.assign(new Error(`column "planned_finish_on" does not exist near ${secret}`), { code: '42703' }) }
    const get = await getFields(h, FLOOR)
    assert.equal(get.statusCode, 503, JSON.stringify(get.body))
    assert.equal(get.body.error.code, 'STOCK_PREPARATION_PROJECT_OVERVIEW_HOST_UNSUPPORTED')
    assert.ok(!JSON.stringify(get.body).includes(secret))
    h.db.selectOne = realSelect
    // A TYPED refusal passes through as built.
    const typed = await patchFields(h, FLOOR, { note: 'x'.repeat(PROJECT_FIELD_TEXT_LIMITS.note + 1) })
    assert.equal(typed.body.error.code, 'STOCK_PREPARATION_PROJECT_FIELDS_INVALID')
  } finally { h.restore() }
})

// ── O-19 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-19 (R10) the store never throws over a pull code\'s shape: UNKNOWN for a non-code, nothing for a non-outcome', async () => {
  const { createStockPreparationProjectTargetStore, normalizeProjectPullCode } = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
  const db = projectSheet.makeMemoryDb()
  const store = createStockPreparationProjectTargetStore({ db })
  db.rowsOf('integration_stock_prep_project_target').push({ tenant_id: TENANT, project_no: PROJECT, status: 'active' })
  for (const code of ['lower', 'HAS SPACE', '1LEADING', 'A'.repeat(80), 42, { code: 'X' }]) {
    assert.equal(await store.recordPullOutcome({ tenantId: TENANT, projectNo: PROJECT, outcome: 'refused', code }), true)
    assert.equal(db.rowsOf('integration_stock_prep_project_target')[0].last_pull_code, 'UNKNOWN', JSON.stringify(code))
  }
  assert.equal(await store.recordPullOutcome({ tenantId: TENANT, projectNo: PROJECT, outcome: 'refused', code: 'TARGET_SCHEMA_INCOMPLETE' }), true)
  assert.equal(db.rowsOf('integration_stock_prep_project_target')[0].last_pull_code, 'TARGET_SCHEMA_INCOMPLETE')
  assert.equal(await store.recordPullOutcome({ tenantId: TENANT, projectNo: PROJECT, outcome: 'exploded' }), false)
  assert.deepEqual(normalizeProjectPullCode(undefined), { code: null, mapped: false })
  assert.deepEqual(normalizeProjectPullCode('  '), { code: null, mapped: false })
  assert.deepEqual(normalizeProjectPullCode('weird code'), { code: 'UNKNOWN', mapped: true })
})

// ── O-20 ───────────────────────────────────────────────────────────────────────────────────────────
// Fix round 2 (F4): nobody waits for the overview lock while holding a pooled connection.
test('O-20 (F4) a refresh in flight + events: in-process events take NO connection and are re-projected before the lock is released; another process\'s events are busy at once, never waiting', async () => {
  const { createStockPreparationProjectTargetStore } = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    h.seedRegistryRow(PROJECT_B)
    assert.equal((await ensure(h, PULLER)).statusCode, 200)
    // THE POOL: every transaction that takes (or tries) the tenant's overview lock holds one pooled connection.
    // Count how many are open at once, and how many ever BLOCK waiting for the lock.
    const OVERVIEW_KEY = `stock-prep-project-overview:${TENANT}`
    const pool = { open: 0, maxOpen: 0, waiting: 0, maxWaiting: 0, opened: 0 }
    const realTransaction = h.db.transaction
    h.db.transaction = (fn) => realTransaction.call(h.db, async (trx) => {
      let counted = false
      const enter = () => {
        if (counted) return
        counted = true
        pool.opened += 1
        pool.open += 1
        pool.maxOpen = Math.max(pool.maxOpen, pool.open)
      }
      const wrapped = {
        ...trx,
        async advisoryXactLock(key) {
          if (key !== OVERVIEW_KEY) return trx.advisoryXactLock(key)
          enter()
          pool.waiting += 1
          pool.maxWaiting = Math.max(pool.maxWaiting, pool.waiting)
          try { return await trx.advisoryXactLock(key) } finally { pool.waiting -= 1 }
        },
        async tryAdvisoryXactLock(key) {
          if (key === OVERVIEW_KEY) enter()
          return trx.tryAdvisoryXactLock(key)
        },
      }
      try { return await fn(wrapped) } finally { if (counted) pool.open -= 1 }
    })
    // Hold the refresh INSIDE its lock, mid-pass (it has read the registry and is writing its first row).
    let signalEntered
    const entered = new Promise((resolve) => { signalEntered = resolve })
    let releaseGate
    const gate = new Promise((resolve) => { releaseGate = resolve })
    const realCreate = h.overviewPort.createRecord
    let gated = false
    h.overviewPort.createRecord = async (input) => {
      if (!gated) { gated = true; signalEntered(); await gate }
      return realCreate(input)
    }
    const refreshing = refresh(h, FLOOR)
    await entered
    assert.equal(pool.open, 1, 'the refresh holds one connection for the overview lock')

    // IN-PROCESS: an archive while the refresh runs. Its registry change commits; its overview update is DEFERRED
    // to the running writer — no connection, not even a busy try.
    const archived = await archive(h, PULLER, PROJECT)
    assert.equal(archived.statusCode, 200, JSON.stringify(archived.body))
    assert.equal(pool.opened, 1, 'the in-process event opened no overview-lock transaction')

    // ANOTHER PROCESS: a second registry store over the same database (its own in-process state), five events.
    // Each answers WITHOUT waiting for the refresh — if any blocked on the lock this would time out.
    const otherProcess = createStockPreparationProjectTargetStore({ db: h.db })
    const otherEvent = (projectNo) => overview.updateProjectOverviewRow({ provisioning: h.provisioning, recordsApi: h.records, store: otherProcess, tenantId: TENANT, projectId: STAGING, projectNo })
    const timeout = new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 2000))
    const outcomes = await Promise.race([Promise.all([1, 2, 3, 4, 5].map(() => otherEvent(PROJECT_B))), timeout])
    assert.notEqual(outcomes, 'TIMEOUT', 'another process\'s events must not wait for the lock')
    assert.deepEqual(outcomes.map((o) => o.outcome).sort(), ['busy', 'deferred', 'deferred', 'deferred', 'deferred'])
    assert.equal(pool.maxWaiting, 0, 'no connection ever BLOCKED on the overview lock')
    assert.ok(pool.maxOpen <= 2, `at most the holder + one non-blocking try at a time (saw ${pool.maxOpen})`)

    // Let the refresh finish: it re-projects the project the in-process event touched, from the registry as it
    // stands NOW — its row says 已归档 although the full pass read the registry before the archive.
    releaseGate()
    const res = await refreshing
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const rowOf = (no) => overviewRows(h).filter((row) => logical(row, 'projectNo') === no)
    assert.equal(rowOf(PROJECT).length, 1)
    assert.equal(logical(rowOf(PROJECT)[0], 'status'), 'archived', 'the in-flight refresh did not miss the archive')
    assert.equal(logical(rowOf(PROJECT)[0], 'postureKey'), 'archived')
    assert.equal(pool.open, 0, 'every overview-lock connection was released')

    // The other process's BUSY event stays dirty there and is reconciled by its next writer (one call drains it).
    const later = await otherEvent(PROJECT)
    assert.equal(later.outcome, 'updated')
    assert.equal(later.projectCount, 2, 'the earlier busy project was drained together with this one')
    assert.equal(pool.maxWaiting, 0)
    h.overviewPort.createRecord = realCreate
    h.db.transaction = realTransaction
  } finally { h.restore() }
})

// ── O-21 ───────────────────────────────────────────────────────────────────────────────────────────
// Fix round 2 (F5): switch OFF, a per-event caller that REACHES the helper (the confirm: its project number
// comes from the ledger, whatever the switch) does zero overview IO — the helper's own switch check is the gate.
test('O-21 (F5) switch OFF (unset or not exactly "true"): the confirm and every other per-event caller do ZERO overview lookups or writes', async () => {
  const fakes = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))
  const { OBJECT_ID: LEDGER_OBJECT, FIRST_CUT_CONFLICT_TYPE, STATUSES, RESOLUTION_ACTIONS } = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
  const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
  const { createStockPreparationProjectTargetStore } = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
  const LEDGER_SHEET = fakes.derivedSheetId ? fakes.derivedSheetId(STAGING, LEDGER_OBJECT) : 'sheet_ledger_s3'
  const OVERVIEW_SHEET = 'sheet_overview_s3'
  const ENV = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
  const runConfirm = async (envValue) => {
    const ledgerRow = fakes.physicalRow(STAGING, LEDGER_OBJECT, {
      decisionId: 'decision_s3_f5', projectNo: PROJECT, conflictType: FIRST_CUT_CONFLICT_TYPE, status: STATUSES.PENDING,
      inputFingerprint: 'sha16:0123456789abcdef', sourceRevision: 'rev-1',
    }, 'rec_ledger_f5')
    ledgerRow.sheetId = LEDGER_SHEET
    const base = fakes.makeFakeProvisioning({ stagingProjectId: STAGING, sheetIdByObjectId: { [LEDGER_OBJECT]: LEDGER_SHEET, [OVERVIEW_OBJECT]: OVERVIEW_SHEET } })
    const overviewLookups = []
    const provisioning = {
      ...base,
      supportsSystemKindStamp: true,
      async findObjectSheet(input) {
        if (input.objectId === OVERVIEW_OBJECT) overviewLookups.push(input.objectId)
        const found = await base.findObjectSheet(input)
        if (!found) return found
        return { ...found, systemKind: input.objectId === OVERVIEW_OBJECT ? KIND : null }
      },
      async ensureObject() { throw new Error('unexpected provisioning write') },
      getFieldId: (projectId, objectId, fieldId) => fakes.physicalFieldId(projectId, objectId, fieldId),
      getObjectViewId: (projectId, objectId, viewId) => `view_${objectId.slice(-6)}_${viewId}`,
    }
    const records = fakes.makeStrictRecordsApi({ stagingProjectId: STAGING, objectIdBySheetId: { [LEDGER_SHEET]: LEDGER_OBJECT, [OVERVIEW_SHEET]: OVERVIEW_OBJECT }, rowsBySheet: { [LEDGER_SHEET]: [ledgerRow], [OVERVIEW_SHEET]: [] } })
    const portCalls = []
    records.stockPreparationOverview = {
      async createRecord({ data }) { portCalls.push('create'); return records.createRecord({ sheetId: OVERVIEW_SHEET, data }) },
      async patchRecord({ recordId, changes }) { portCalls.push('patch'); return records.patchRecord({ sheetId: OVERVIEW_SHEET, recordId, changes }) },
      async deleteRecord() { portCalls.push('delete'); throw new Error('unexpected delete') },
    }
    const db = projectSheet.makeMemoryDb()
    const store = createStockPreparationProjectTargetStore({ db, idGenerator: () => 'pt-f5' })
    db.rowsOf('integration_stock_prep_project_target').push({
      id: 'seed', tenant_id: TENANT, project_no: PROJECT, sheet_id: 'sheet_project_s3', object_id: 'plm_stock_preparation_sandbox_p_0123456789abcdef01234567',
      status: 'active', created_by: 'seed', created_at: new Date('2026-10-08T00:00:00Z'), archived_at: null, updated_at: new Date('2026-10-08T00:00:00Z'),
    })
    const lockCalls = []
    const realTry = store.tryWithOverviewLock
    store.tryWithOverviewLock = (input, fn) => { lockCalls.push(input.tenantId); return realTry(input, fn) }
    const routes = new Map()
    const previous = process.env[ENV]
    if (envValue === undefined) delete process.env[ENV]
    else process.env[ENV] = envValue
    try {
      httpRoutes.registerIntegrationRoutes({
        context: { api: { http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } }, multitable: { provisioning, records } }, storage: new Map(), config: {} },
        services: {
          ...Object.fromEntries(['externalSystemRegistry', 'adapterRegistry', 'pipelineRegistry', 'pipelineRunner', 'deadLetterStore', 'stagingInstaller', 'templateRegistry', 'readSourceConfigStore', 'readSourceCompositionConfigStore', 'bridgeAgentChecklistStore']
            .map((name) => [name, new Proxy({}, { get: (_target, method) => async () => { throw new Error(`unexpected ${name}.${String(method)}`) } })])),
          stockPreparationAuditStore: { async append() { return { ok: true } } },
          stockPreparationProjectTargetStore: store,
          tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
        },
        logger: { info() {}, warn() {}, error() {} },
      })
      const res = await projectSheet.call(routes, 'POST', '/api/integration/stock-preparation/confirmation-decisions/confirm', {
        user: FLOOR,
        body: { decisionId: 'decision_s3_f5', inputFingerprint: 'sha16:0123456789abcdef', resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS },
      })
      return { res, overviewLookups, portCalls, lockCalls, overviewRows: records.rows(OVERVIEW_SHEET) }
    } finally {
      if (previous === undefined) delete process.env[ENV]
      else process.env[ENV] = previous
    }
  }
  for (const envValue of [undefined, 'TRUE', 'True', 'true ', '1', '']) {
    const run = await runConfirm(envValue)
    assert.equal(run.res.statusCode, 200, `${JSON.stringify(envValue)}: ${JSON.stringify(run.res.body)}`)
    assert.deepEqual(run.overviewLookups, [], `${JSON.stringify(envValue)}: no overview lookup`)
    assert.deepEqual(run.lockCalls, [], `${JSON.stringify(envValue)}: no overview lock`)
    assert.deepEqual(run.portCalls, [], `${JSON.stringify(envValue)}: no overview write`)
    assert.equal(run.overviewRows.length, 0)
  }
  // Control (the fixture CAN see it): exactly 'true' → the confirm looks the overview up and writes its row.
  const on = await runConfirm('true')
  assert.equal(on.res.statusCode, 200, JSON.stringify(on.res.body))
  assert.deepEqual(on.overviewLookups, [OVERVIEW_OBJECT])
  assert.equal(on.lockCalls.length, 1)
  assert.deepEqual(on.portCalls, ['create'])

  // The other per-event callers with the switch off: create / archive / restore / project fields are 404 before
  // anything (O-04), and a dry-run has no project target to update — none of them touches the overview.
  const off = mount({ switchOn: false })
  try {
    off.seedRegistryRow(PROJECT)
    for (const run of [() => createTarget(off, PULLER), () => archive(off), () => restore(off), () => patchFields(off, FLOOR, { note: NOTE }), () => dryRun(off)]) {
      await run()
    }
    assert.ok(!off.provisioning.calls.some((c) => c[0] === 'findObjectSheet' && c[1] === OVERVIEW_OBJECT), 'no overview lookup')
    assert.ok(!off.records.calls.some((c) => String(c[0]).startsWith('overview.')), 'no overview write')
    assert.ok(!off.db.calls.some((c) => String(c).includes('stock-prep-project-overview')), 'no overview lock')
  } finally { off.restore() }
})

// ── O-22 ───────────────────────────────────────────────────────────────────────────────────────────
// Fix round 2 (F3): the overview's rows are written ONLY through the host's overview port.
test('O-22 (F3) the overview is written only through the host overview port; the generic writes refuse it; a host without the port is 503 before any IO', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    assert.equal((await ensure(h, PULLER)).statusCode, 200)
    const res = await refresh(h, FLOOR)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(overviewRows(h).length, 1)
    const generic = h.records.calls.filter((c) => ['createRecord', 'patchRecord', 'deleteRecord'].includes(c[0]) && c[1] === overviewSheetId(h))
    assert.deepEqual(generic, [], 'no generic record write ever addressed the overview')
    assert.ok(h.records.calls.some((c) => c[0] === 'overview.createRecord' && c[1] === overviewSheetId(h)), 'the row was created through the port')
    // The (fake) host refuses a generic write to the stamped overview — what a pipeline / adapter would hit.
    await assert.rejects(h.records.createRecord({ sheetId: overviewSheetId(h), data: {} }), (error) => error.code === 'STOCK_PREP_OVERVIEW_READ_ONLY')
    // A per-event update writes through the port too.
    assert.equal((await archive(h)).statusCode, 200)
    assert.equal(logical(overviewRows(h)[0], 'status'), 'archived')
    assert.ok(h.records.calls.some((c) => c[0] === 'overview.patchRecord'), 'the per-event patch went through the port')

    // A host WITHOUT the port: the refresh is a typed 503 before any IO (no lookup, no lock).
    delete h.records.stockPreparationOverview
    passCooldown()
    const callsBefore = h.provisioning.calls.length
    const dbBefore = h.db.calls.length
    const refused = await refresh(h, FLOOR)
    assert.equal(refused.statusCode, 503, JSON.stringify(refused.body))
    assert.equal(refused.body.error.code, 'STOCK_PREPARATION_PROJECT_OVERVIEW_HOST_UNSUPPORTED')
    assert.equal(refused.body.error.details.reason, 'records_port_missing')
    assert.equal(h.provisioning.calls.length, callsBefore, 'no host lookup')
    assert.ok(!h.db.calls.slice(dbBefore).some((c) => String(c).includes('stock-prep-project-overview')), 'no overview lock')
  } finally { h.restore() }
})

// ── O-23 ───────────────────────────────────────────────────────────────────────────────────────────
// Fix round 2 (F4): the writer re-checks the dirty set AFTER its lock is released and before it stops.
test('O-23 (F4) an event that lands after the writer drained but before it stopped (its lock transaction finishing) is not stranded: the writer goes round once more', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    assert.equal((await ensure(h, PULLER)).statusCode, 200)
    assert.equal((await refresh(h, FLOOR)).statusCode, 200)
    const rowOf = () => overviewRows(h).filter((row) => logical(row, 'projectNo') === PROJECT)
    assert.equal(logical(rowOf()[0], 'status'), 'active')
    // Hold the FIRST overview-lock transaction after it has finished (drained, lock released) but before the
    // writer sees it return — the window between "drained" and "not running any more".
    const OVERVIEW_KEY = `stock-prep-project-overview:${TENANT}`
    let armed = true
    let signalFinished
    const finished = new Promise((resolve) => { signalFinished = resolve })
    let releaseWindow
    const window = new Promise((resolve) => { releaseWindow = resolve })
    const realTransaction = h.db.transaction
    h.db.transaction = async (fn) => {
      let overviewTx = false
      const out = await realTransaction.call(h.db, async (trx) => fn({
        ...trx,
        async tryAdvisoryXactLock(key) {
          if (key === OVERVIEW_KEY) overviewTx = true
          return trx.tryAdvisoryXactLock(key)
        },
      }))
      if (overviewTx && armed) {
        armed = false
        signalFinished()
        await window
      }
      return out
    }
    // Event 1 becomes the writer, drains its project, and is held in the window.
    const first = patchFields(h, FLOOR, { note: NOTE })
    await finished
    // Event 2, IN the window: the writer is still running, so it is only marked dirty and deferred.
    const archived = await archive(h, PULLER, PROJECT)
    assert.equal(archived.statusCode, 200, JSON.stringify(archived.body))
    assert.equal(logical(rowOf()[0], 'status'), 'active', 'nothing re-projected yet — the writer is in its window')
    releaseWindow()
    assert.equal((await first).statusCode, 200)
    assert.equal(rowOf().length, 1)
    assert.equal(logical(rowOf()[0], 'status'), 'archived', 'the writer went round again after its lock was released')
    assert.equal(logical(rowOf()[0], 'note'), NOTE)
    h.db.transaction = realTransaction
  } finally { h.restore() }
})

// ── O-24 ───────────────────────────────────────────────────────────────────────────────────────────
// S3 follow-up A: this suite (and any that adopts support/fail-closed-suite-runner.cjs) cannot exit 0 past a hang.
test('O-24 (follow-up A) the suite runner fails closed: FAIL then a hang with nothing alive exits 1 (sentinel); a hang that keeps the loop alive times out, the run continues, and exits 1', () => {
  const { spawnSync } = require('node:child_process')
  const runnerPath = path.join(__dirname, 'support', 'fail-closed-suite-runner.cjs')
  const probe = (body) => spawnSync(process.execPath, ['-e', `const { runFailClosedSuite } = require(${JSON.stringify(runnerPath)});\n${body}`], { encoding: 'utf8', timeout: 20000 })
  // (1) The S3 review's case: a test printed FAIL, the next awaits a promise nothing can settle and nothing keeps
  // the event loop alive — Node runs out of work before the runner's own exit(1).
  const drained = probe(`runFailClosedSuite('probe-drain', [
    ['fails first', () => { throw new Error('synthetic failure') }],
    ['hangs with nothing alive', () => new Promise(() => {})],
    ['never reached', () => {}],
  ], { testTimeoutMs: 60000 })`)
  assert.equal(drained.status, 1, `a drained hang must exit 1 (status ${drained.status}, signal ${drained.signal}); stderr: ${drained.stderr}`)
  assert.match(drained.stderr, /FAIL: fails first/)
  assert.match(drained.stderr, /probe-drain FAILED: the event loop drained before every test settled/)
  assert.ok(!drained.stdout.includes('never reached OK'), 'the runner stopped at the hang')
  // (2) A hang that KEEPS the loop alive (a leaked interval): no drain, so only the per-test timeout can end it.
  const alive = probe(`runFailClosedSuite('probe-alive', [
    ['hangs with the loop alive', () => new Promise(() => { setInterval(() => {}, 50) })],
    ['runs after the timeout', () => {}],
  ], { testTimeoutMs: 300 })`)
  assert.equal(alive.status, 1, `a live hang must time out and exit 1 (status ${alive.status}, signal ${alive.signal}); stderr: ${alive.stderr}`)
  assert.match(alive.stderr, /FAIL: hangs with the loop alive/)
  assert.match(alive.stderr, /timed out after 300 ms/)
  assert.match(alive.stdout, / {2}runs after the timeout OK/)
  assert.match(alive.stderr, /probe-alive FAILED \(1\)/)
  // (3) Control: a passing run exits 0 and says so.
  const passing = probe(`runFailClosedSuite('probe-ok', [['passes', async () => {}]])`)
  assert.equal(passing.status, 0, passing.stderr)
  assert.match(passing.stdout, /probe-ok: all assertions passed/)
})

// ── O-25 ───────────────────────────────────────────────────────────────────────────────────────────
// S3 follow-up B: the OTHER PROCESS case of F4 at the route — the in-process `running` flag cannot see it.
test('O-25 (follow-up B) another process holds the overview lock: the refresh route answers 409 BUSY, writes and audits nothing, and CLEARS the cooldown — the first click after the lock frees refreshes', async () => {
  const { createStockPreparationProjectTargetStore } = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    assert.equal((await ensure(h, PULLER)).statusCode, 200)
    // Another process: its OWN registry store (own in-process state) over the same database, holding the lock.
    const otherProcess = createStockPreparationProjectTargetStore({ db: h.db })
    let signalHeld
    const held = new Promise((resolve) => { signalHeld = resolve })
    let releaseLock
    const gate = new Promise((resolve) => { releaseLock = resolve })
    const holder = otherProcess.tryWithOverviewLock({ tenantId: TENANT }, async () => { signalHeld(); await gate; return 'held' })
    await held
    const auditsBefore = h.auditAppends.length
    const busy = await refresh(h, FLOOR)
    assert.equal(busy.statusCode, 409, JSON.stringify(busy.body))
    assert.equal(busy.body.ok, false)
    assert.equal(busy.body.error.code, 'STOCK_PREPARATION_PROJECT_OVERVIEW_BUSY')
    assert.equal(overviewRows(h).length, 0, 'nothing was written')
    assert.equal(h.auditAppends.length, auditsBefore, 'nothing was audited')
    releaseLock()
    assert.deepEqual(await holder, { acquired: true, value: 'held' })
    // The cooldown was CLEARED by the BUSY answer: the very next click (no clock step) refreshes for real.
    const next = await refresh(h, FLOOR)
    assert.equal(next.statusCode, 200, JSON.stringify(next.body))
    assert.equal(next.body.data.fresh, true, 'the BUSY click did not leave a cooldown behind')
    assert.equal(overviewRows(h).length, 1)
  } finally { h.restore() }
})

// ── O-26 ───────────────────────────────────────────────────────────────────────────────────────────
// S3 follow-up C: a refresh never reports `fresh: true` over a project it could not write.
test('O-26 (follow-up C) a project write that fails in the full pass: 503 REFRESH_INCOMPLETE (counts only), audited `incomplete`, cooldown cleared, the project stays DIRTY and the next writer heals it', async () => {
  const logger = capturingLogger()
  const h = mount({ logger })
  try {
    h.seedRegistryRow(PROJECT)
    h.seedRegistryRow(PROJECT_B)
    assert.equal((await ensure(h, PULLER)).statusCode, 200)
    const realCreate = h.overviewPort.createRecord
    h.overviewPort.createRecord = async (input = {}) => {
      if (input.data && input.data[phys(OVERVIEW_OBJECT, 'projectNo')] === PROJECT_B) {
        throw Object.assign(new Error(`overview write failed for ${PROJECT_B} with a value`), { code: 'SYNTHETIC_OVERVIEW_DOWN' })
      }
      return realCreate(input)
    }
    const res = await refresh(h, FLOOR)
    assert.equal(res.statusCode, 503, JSON.stringify(res.body))
    assert.equal(res.body.ok, false)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_OVERVIEW_REFRESH_INCOMPLETE')
    assert.deepEqual({ ...res.body.error.details }, { objectId: OVERVIEW_OBJECT, failedProjectCount: 1, projectCount: 2 })
    assert.ok(!JSON.stringify(res.body).includes(PROJECT_B) && !JSON.stringify(res.body).includes('with a value'), 'values-free')
    assert.deepEqual(overviewRows(h).map((row) => logical(row, 'projectNo')), [PROJECT], 'the row that could be written stands')
    // Audited as `incomplete` — counts + the failed count; never `refreshed`.
    const audits = h.auditAppends.filter((e) => e.action === 'project_overview_refresh' && e.mode !== 'sheet_created')
    assert.deepEqual(audits.map((e) => e.mode), ['incomplete'])
    assert.deepEqual(audits[0].detail, { projectCount: 2, countedCount: 2, unreadableCount: 0, boundedCount: 0, rowsCreated: 1, rowsUpdated: 0, rowsUnchanged: 0, rowsRemovedDuplicate: 0, rowsRemovedOrphan: 0, truncated: false, ledgerReady: false, failedProjectCount: 1 })
    assert.ok(!JSON.stringify(h.auditAppends).includes(PROJECT_B), 'the audit carries no project number')
    const warns = logger.warnings.filter((w) => /refresh could not write every project/.test(w.message))
    assert.deepEqual(warns.map((w) => w.meta), [{ code: 'SYNTHETIC_OVERVIEW_DOWN', failedProjectCount: 1 }])
    // The failed project is still DIRTY (with a recount) — not dropped.
    const state = overview.__internals.overviewWriterState(h.projectTargetStore, TENANT)
    assert.deepEqual([...state.dirty.entries()], [[PROJECT_B, { recount: true }]])
    assert.equal(state.running, false)
    // The host is back. The NEXT overview writer — an event on ANOTHER project — heals it (drains the dirty set).
    h.overviewPort.createRecord = realCreate
    assert.equal((await patchFields(h, FLOOR, { note: NOTE })).statusCode, 200)
    assert.deepEqual(overviewRows(h).map((row) => logical(row, 'projectNo')).sort(), [PROJECT, PROJECT_B])
    assert.equal(state.dirty.size, 0)
    // The cooldown was cleared by the incomplete answer: the next click refreshes (no clock step) and is fresh.
    const again = await refresh(h, FLOOR)
    assert.equal(again.statusCode, 200, JSON.stringify(again.body))
    assert.equal(again.body.data.fresh, true)
    assert.equal(h.auditAppends.at(-1).mode, 'refreshed')
  } finally { h.restore() }
})

test('O-26b (follow-up C) the S3 review\'s case: an event deferred INTO a running refresh whose write then fails makes the refresh REFRESH_INCOMPLETE (not fresh), and the project stays dirty', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    h.seedRegistryRow(PROJECT_B)
    assert.equal((await ensure(h, PULLER)).statusCode, 200)
    // Hold the refresh inside its lock at its first row write.
    let signalEntered
    const entered = new Promise((resolve) => { signalEntered = resolve })
    let releaseGate
    const gate = new Promise((resolve) => { releaseGate = resolve })
    const realCreate = h.overviewPort.createRecord
    let gated = false
    h.overviewPort.createRecord = async (input) => {
      if (!gated) { gated = true; signalEntered(); await gate }
      return realCreate(input)
    }
    const refreshing = refresh(h, FLOOR)
    await entered
    // An in-process event while it runs: deferred to the running writer (marked dirty, no write of its own).
    assert.equal((await archive(h, PULLER, PROJECT)).statusCode, 200)
    // The drain's re-projection of that project is a PATCH (the full pass created its row) — and it fails.
    h.overviewPort.patchRecord = async () => { throw Object.assign(new Error('patch failed'), { code: 'SYNTHETIC_OVERVIEW_DOWN' }) }
    releaseGate()
    const res = await refreshing
    assert.equal(res.statusCode, 503, `a failed deferred-event write is not a fresh refresh: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_OVERVIEW_REFRESH_INCOMPLETE')
    assert.equal(res.body.error.details.failedProjectCount, 1)
    assert.ok(!h.auditAppends.some((e) => e.action === 'project_overview_refresh' && e.mode === 'refreshed'), 'no success audit')
    const state = overview.__internals.overviewWriterState(h.projectTargetStore, TENANT)
    assert.deepEqual([...state.dirty.keys()], [PROJECT], 'the project whose write failed is still dirty')
    assert.equal(logical(overviewRows(h).find((row) => logical(row, 'projectNo') === PROJECT), 'status'), 'active', 'its row is stale — which is why it stays dirty')
  } finally { h.restore() }
})

test('O-26c (follow-up C) the PER-EVENT path: a project whose overview write fails stays dirty and is healed by the next writer, even one for another project', async () => {
  const logger = capturingLogger()
  const h = mount({ logger })
  try {
    h.seedRegistryRow(PROJECT)
    h.seedRegistryRow(PROJECT_B)
    assert.equal((await ensure(h, PULLER)).statusCode, 200)
    assert.equal((await refresh(h, FLOOR)).statusCode, 200)
    const realPatch = h.overviewPort.patchRecord
    h.overviewPort.patchRecord = async () => { throw Object.assign(new Error('patch failed'), { code: 'SYNTHETIC_OVERVIEW_DOWN' }) }
    assert.equal((await archive(h, PULLER, PROJECT)).statusCode, 200, 'the event stands')
    const state = overview.__internals.overviewWriterState(h.projectTargetStore, TENANT)
    assert.deepEqual([...state.dirty.keys()], [PROJECT], 'the failed project was not dropped')
    assert.equal(logger.warnings.filter((w) => /overview row could not be updated/.test(w.message)).length, 1)
    h.overviewPort.patchRecord = realPatch
    // An event on PROJECT_B becomes the writer and drains PROJECT too.
    assert.equal((await patchFields(h, FLOOR, { note: NOTE }, PROJECT_B)).statusCode, 200)
    assert.equal(state.dirty.size, 0)
    assert.equal(logical(overviewRows(h).find((row) => logical(row, 'projectNo') === PROJECT), 'status'), 'archived', 'healed')
  } finally { h.restore() }
})

// ── O-27 ───────────────────────────────────────────────────────────────────────────────────────────
// S3 follow-up D: the refresh reads every page BEFORE it deletes anything.
test('O-27 (follow-up D) more than one page of overview rows: orphans on page one are deleted only after every page was read — no project row is skipped, none is duplicated; past the read bound a project is never created blind', async () => {
  const { OVERVIEW_READ_PAGE_LIMIT, OVERVIEW_READ_MAX_PAGES } = overview.__internals
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    h.seedRegistryRow(PROJECT_B)
    assert.equal((await ensure(h, PULLER)).statusCode, 200)
    const sheetId = overviewSheetId(h)
    const pushRow = (id, projectNo) => h.rows.push({ id, sheetId, version: 1, data: { [phys(OVERVIEW_OBJECT, 'projectNo')]: projectNo } })
    // Page one is ALL orphans (unregistered projects); the two registered rows sit on page two.
    const orphanCount = OVERVIEW_READ_PAGE_LIMIT + 20
    for (let i = 0; i < orphanCount; i += 1) pushRow(`rec_orphan_${i}`, `PRJ-ORPHAN-${i}`)
    pushRow('rec_keep_a', PROJECT)
    pushRow('rec_keep_b', PROJECT_B)
    const res = await refresh(h, FLOOR)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.rowsRemovedOrphan, orphanCount)
    assert.equal(res.body.data.rowsCreated, 0, 'both projects\' rows were SEEN (page two read before page one was deleted) — nothing created')
    assert.equal(res.body.data.rowsUpdated, 2)
    assert.equal(res.body.data.overflow, false)
    assert.deepEqual(overviewRows(h).map((row) => row.id).sort(), ['rec_keep_a', 'rec_keep_b'], 'exactly one row per project — the kept ones')

    // PAST THE BOUND: more rows than the read bound, the project's row beyond it. The full pass must not create
    // it blind; the drain (same lock) reads that project's rows by number and patches the one that exists.
    const beyond = OVERVIEW_READ_PAGE_LIMIT * OVERVIEW_READ_MAX_PAGES
    h.rows.splice(h.rows.findIndex((row) => row.id === 'rec_keep_a'), 1)
    h.rows.splice(h.rows.findIndex((row) => row.id === 'rec_keep_b'), 1)
    for (let i = 0; i < beyond + 1; i += 1) pushRow(`rec_orphan2_${i}`, `PRJ-ORPHAN2-${i}`)
    pushRow('rec_far_a', PROJECT)
    pushRow('rec_far_b', PROJECT_B)
    passCooldown()
    const far = await refresh(h, FLOOR)
    assert.equal(far.statusCode, 200, JSON.stringify(far.body))
    assert.equal(far.body.data.overflow, true)
    assert.equal(far.body.data.rowsCreated, 0, 'no blind create past the read bound')
    const projectRows = overviewRows(h).filter((row) => [PROJECT, PROJECT_B].includes(logical(row, 'projectNo')))
    assert.deepEqual(projectRows.map((row) => row.id).sort(), ['rec_far_a', 'rec_far_b'], 'the rows past the bound were found by number and kept')
    assert.equal(logical(projectRows.find((row) => row.id === 'rec_far_a'), 'status'), 'active', 'and re-projected')
    // The next refresh sees the rest of the residue.
    passCooldown()
    const rest = await refresh(h, FLOOR)
    assert.equal(rest.statusCode, 200)
    assert.equal(rest.body.data.overflow, false)
    assert.equal(rest.body.data.rowsRemovedOrphan, 1, 'the one orphan past the bound is removed now')
    assert.deepEqual(overviewRows(h).map((row) => row.id).sort(), ['rec_far_a', 'rec_far_b'])
  } finally { h.restore() }
})

// S3 follow-up A: the fail-closed runner (support/fail-closed-suite-runner.cjs) — exit sentinel + per-test timeout.
runFailClosedSuite('stock-preparation-project-overview.test.cjs', tests)
