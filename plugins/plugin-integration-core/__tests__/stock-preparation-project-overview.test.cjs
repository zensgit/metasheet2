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
// Synthetic values only.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const projectSheet = require(path.join(__dirname, 'support', 'stock-preparation-project-sheet-harness.cjs'))
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
const putFields = (h, user, body, projectNo = PROJECT) => projectSheet.call(h.routes, 'PUT', FIELDS_PATH, { user, params: { projectNo }, body })
const refresh = (h, user = FLOOR) => projectSheet.call(h.routes, 'POST', REFRESH_PATH, { user, body: {} })
const listTargets = (h, user = FLOOR) => projectSheet.call(h.routes, 'GET', LIST_PATH, { user, query: { tenantId: TENANT } })
const getTarget = (h, user, projectNo = PROJECT) => projectSheet.call(h.routes, 'GET', TARGET_PATH, { user, params: { projectNo }, query: { tenantId: TENANT } })
const dryRun = (h, user = PULLER, projectNo = PROJECT) => projectSheet.call(h.routes, 'POST', DRY_RUN_PATH, { user, params: { actionId: ACTION_ID }, body: { parameters: { projectNo } }, query: { tenantId: TENANT } })
const directory = (h, user = FLOOR) => projectSheet.call(h.routes, 'GET', DIRECTORY_PATH, { user, query: { includePullTargets: '1' } })

function mount(options = {}) {
  const h = projectSheet.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, switchOn: true, ...options })
  // The harness records fake ignores filters / offsets and does not persist a patch; the overview
  // needs both (it narrows a project sheet by project number and reads its own rows back), so the
  // fake is tightened HERE, on the same object the routes read through `context.api.multitable`.
  const rows = []
  h.records.queryRecords = async (input = {}) => {
    h.records.calls.push(['queryRecords', input.sheetId])
    const filters = input.filters || {}
    const hit = rows.filter((row) => row.sheetId === input.sheetId && Object.entries(filters).every(([k, v]) => row.data[k] === v))
    const offset = Number(input.offset || 0)
    const limit = Number(input.limit || hit.length)
    return projectSheet.clone(hit.slice(offset, offset + limit))
  }
  h.records.createRecord = async (input = {}) => {
    h.records.calls.push(['createRecord', input.sheetId])
    const created = { id: `rec_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
    rows.push(created)
    return projectSheet.clone(created)
  }
  h.records.patchRecord = async (input = {}) => {
    h.records.calls.push(['patchRecord', input.sheetId])
    const row = rows.find((candidate) => candidate.id === input.recordId && candidate.sheetId === input.sheetId)
    assert.ok(row, 'patchRecord addresses a row the fake holds')
    Object.assign(row.data, input.changes || {})
    row.version += 1
    return projectSheet.clone(row)
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
const hostWrites = (h) => h.provisioning.calls.filter((c) => ['ensureObject', 'ensureView', 'ensureMissingObjectFields', 'patchObjectFieldProperty', 'grantSheetRoleWrite'].includes(c[0]))

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
test('O-04 switch OFF: the three routes are 404 DISABLED with zero IO; the gate refuses first', async () => {
  const h = mount({ switchOn: false })
  try {
    h.seedRegistryRow(PROJECT)
    for (const [label, run] of [['get', () => getFields(h, FLOOR)], ['put', () => putFields(h, FLOOR, { note: NOTE })], ['refresh', () => refresh(h, FLOOR)]]) {
      const res = await run()
      assert.equal(res.statusCode, 404, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED')
    }
    assert.deepEqual(h.db.calls, [], 'no registry statement')
    assert.deepEqual(h.provisioning.calls, [], 'no host call')
    assert.deepEqual(h.records.calls, [], 'no records call')
    assert.deepEqual(h.auditAppends, [])
    for (const run of [() => getFields(h, READ_ONLY), () => putFields(h, READ_ONLY, { note: NOTE }), () => refresh(h, READ_ONLY)]) {
      const res = await run()
      assert.equal(res.statusCode, 403, JSON.stringify(res.body))
    }
    assert.deepEqual(h.db.calls, [])
  } finally { h.restore() }
})

// ── O-05 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-05 project fields: the closed whitelist, the caps, the calendar day, absent and archived — before any write, values-free', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    const unknown = await putFields(h, FLOOR, { note: NOTE, owner: 'x' })
    assert.equal(unknown.statusCode, 400, JSON.stringify(unknown.body))
    assert.equal(unknown.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_REQUEST_INVALID')
    const cases = [
      [{ responsibleLabel: 'x'.repeat(PROJECT_FIELD_TEXT_LIMITS.responsibleLabel + 1) }, 'responsibleLabel'],
      [{ note: 'y'.repeat(PROJECT_FIELD_TEXT_LIMITS.note + 1) }, 'note'],
      [{ plannedFinishOn: '2026-13-01' }, 'plannedFinishOn'],
      [{ plannedFinishOn: '2026-02-30' }, 'plannedFinishOn'],
      [{ plannedFinishOn: '2026-12-24T00:00:00Z' }, 'plannedFinishOn'],
      [{ note: 42 }, 'note'],
      [{}, 'body'],
    ]
    for (const [body, field] of cases) {
      const res = await putFields(h, FLOOR, body)
      assert.equal(res.statusCode, 422, `${JSON.stringify(body).slice(0, 40)}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_FIELDS_INVALID')
      assert.equal(res.body.error.details.field, field)
      const serialized = JSON.stringify(res.body)
      assert.ok(!serialized.includes('xxxxx') && !serialized.includes('yyyyy') && !serialized.includes('2026-13') && !serialized.includes('2026-02-30'), 'the refusal never echoes the value')
    }
    assert.ok(!h.db.calls.some((c) => c.startsWith('updateRow')), 'no update statement for a refused patch')
    assert.deepEqual(h.auditAppends, [])
    // Absent (another project) and archived.
    const absent = await putFields(h, FLOOR, { note: NOTE }, 'PRJ-S3-NOPE')
    assert.equal(absent.statusCode, 409)
    assert.equal(absent.body.error.code, 'STOCK_PREPARATION_PROJECT_ABSENT')
    h.seedRegistryRow(PROJECT_B, { archived: true })
    const archived = await putFields(h, FLOOR, { note: NOTE }, PROJECT_B)
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
    const res = await putFields(h, FLOOR, { responsibleLabel: ` ${RESPONSIBLE} `, note: NOTE, plannedFinishOn: DAY })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.data.fields, { responsibleLabel: RESPONSIBLE, note: NOTE, plannedFinishOn: DAY })
    assert.deepEqual(res.body.data.changed, ['responsibleLabel', 'note', 'plannedFinishOn'])
    assert.equal(res.body.data.status, 'active')
    assert.deepEqual(res.body.data.may, { update: true })
    assert.ok(typeof res.body.data.updatedAt === 'string')
    // Order: transaction → the tenant lock → FOR UPDATE → the compare-and-set update.
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
    const partial = await putFields(h, FLOOR, { note: '' })
    assert.equal(partial.statusCode, 200)
    assert.deepEqual(partial.body.data.changed, ['note'])
    assert.deepEqual(partial.body.data.fields, { responsibleLabel: RESPONSIBLE, note: null, plannedFinishOn: DAY })
    const cleared = await putFields(h, WORKBENCH_ADMIN, { plannedFinishOn: null })
    assert.equal(cleared.statusCode, 200)
    assert.deepEqual(cleared.body.data.fields, { responsibleLabel: RESPONSIBLE, note: null, plannedFinishOn: null })
    assert.deepEqual(h.auditAppends.slice(1).map((e) => e.detail), [{ updatedFieldCount: 1, fields: { note: 1 } }, { updatedFieldCount: 1, fields: { plannedFinishOn: 1 } }])
  } finally { h.restore() }
})

// ── O-07 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-07 the refresh creates the overview once — stamped, with its two views — and never again', async () => {
  const h = mount()
  try {
    const first = await refresh(h)
    assert.equal(first.statusCode, 200, JSON.stringify(first.body))
    assert.equal(first.body.data.sheetCreated, true)
    assert.equal(first.body.data.sheetId, overviewSheetId(h))
    assert.equal(first.body.data.activeViewId, `view_${OVERVIEW_OBJECT.slice(-8)}_overview-active`)
    assert.equal(first.body.data.archivedViewId, `view_${OVERVIEW_OBJECT.slice(-8)}_overview-archived`)
    assert.deepEqual(hostWrites(h).map((c) => c.slice(0, 2)), [['ensureObject', OVERVIEW_OBJECT], ['ensureView', 'overview-active'], ['ensureView', 'overview-archived']])
    const object = h.provisioning.objects.get(`${STAGING}/${OVERVIEW_OBJECT}`)
    assert.equal(object.systemKind, KIND, 'the host was asked to stamp the overview kind')
    assert.deepEqual([...object.fields.keys()], [...overview.STOCK_PREPARATION_PROJECT_OVERVIEW_FIELD_IDS])
    assert.deepEqual(h.auditAppends.map((e) => [e.action, e.mode, e.subjectId]), [['project_overview_refresh', 'sheet_created', overviewSheetId(h)]])
    assert.deepEqual(h.auditAppends[0].detail, { projectCount: 0, countedCount: 0, unreadableCount: 0, boundedCount: 0, rowsCreated: 0, rowsUpdated: 0, rowsUnchanged: 0, truncated: false, ledgerReady: false })
    // The list now hands the home page the overview's handles.
    const list = await listTargets(h)
    assert.deepEqual(list.body.data.overview, { sheetId: overviewSheetId(h), activeViewId: first.body.data.activeViewId, archivedViewId: first.body.data.archivedViewId })
    h.provisioning.calls.length = 0
    const second = await refresh(h)
    assert.equal(second.statusCode, 200)
    assert.equal(second.body.data.sheetCreated, false)
    assert.deepEqual(hostWrites(h), [], 'a second refresh writes no sheet and no view')
    assert.equal(h.auditAppends[1].mode, 'refreshed')
  } finally { h.restore() }
})

// ── O-08 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-08 fail-closed on the stamp: an older host that does not report the kind, or an unstamped existing sheet, is 409 and nothing is written', async () => {
  const h = mount()
  try {
    const realEnsure = h.provisioning.ensureObject
    h.provisioning.ensureObject = async (input) => {
      const out = await realEnsure({ ...input, systemKind: undefined })
      return out
    }
    const res = await refresh(h)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_OVERVIEW_NOT_STAMPED')
    assert.deepEqual({ ...res.body.error.details }, { objectId: OVERVIEW_OBJECT, mode: 'created', reportedKind: 'none' })
    assert.deepEqual(h.records.calls, [], 'no row written')
    assert.deepEqual(h.auditAppends, [])
    // The unstamped sheet now EXISTS on the host; the next refresh refuses it too (an admin removes it).
    h.provisioning.ensureObject = realEnsure
    const again = await refresh(h)
    assert.equal(again.statusCode, 409)
    assert.deepEqual({ ...again.body.error.details }, { objectId: OVERVIEW_OBJECT, mode: 'existing', reportedKind: 'none' })
    assert.deepEqual(h.records.calls, [])
    // A sheet reporting SOME OTHER kind is refused the same way.
    h.provisioning.objects.get(`${STAGING}/${OVERVIEW_OBJECT}`).systemKind = 'people_directory'
    const other = await refresh(h)
    assert.equal(other.statusCode, 409)
    assert.equal(other.body.error.details.reportedKind, 'other')
  } finally { h.restore() }
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
test('O-10 the projection end to end: one row per registry row, deep link, posture, texts, counts, 截至, registry stamped, unchanged rows cost no write', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    h.seedRegistryRow(PROJECT_B, { archived: true })
    seedProjectRows(h, PROJECT, { total: 4, active: 3, procurementDone: 1, warehouseDone: 3 })
    assert.equal((await putFields(h, FLOOR, { responsibleLabel: RESPONSIBLE, note: NOTE, plannedFinishOn: DAY })).statusCode, 200)
    h.records.calls.length = 0
    const res = await refresh(h, FLOOR)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const summary = res.body.data
    assert.equal(summary.projectCount, 2)
    assert.equal(summary.countedCount, 2)
    assert.equal(summary.rowsCreated, 2)
    assert.equal(summary.ledgerReady, false, 'no ledger on this substrate → pending counts are zero and said so')
    assert.ok(typeof summary.countsAt === 'string' && !Number.isNaN(Date.parse(summary.countsAt)))
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
    assert.equal(logical(a, 'countsAt'), summary.countsAt, '「截至」 is the refresh\'s clock')
    assert.equal(logical(b, 'status'), 'archived')
    assert.equal(logical(b, 'postureKey'), 'archived')
    assert.equal(logical(b, 'rowCount'), 0)
    assert.equal(logical(b, 'responsibleLabel'), null)
    // The registry's count columns were stamped, and the list shows them (the home's 「共 N 行」).
    const stamped = registryRow(h)
    assert.equal(stamped.row_count, 4)
    assert.equal(stamped.active_row_count, 3)
    assert.equal(stamped.procurement_open_count, 2)
    assert.equal(stamped.warehouse_open_count, 0)
    assert.equal(stamped.counts_bounded, false)
    assert.ok(stamped.counts_at instanceof Date)
    const list = await listTargets(h)
    const item = list.body.data.items.find((i) => i.projectNo === PROJECT)
    assert.deepEqual([item.rowCount, item.activeRowCount, item.procurementOpenCount, item.warehouseOpenCount, item.countsBounded], [4, 3, 2, 0, false])
    const target = await getTarget(h, FLOOR)
    assert.equal(target.body.data.rowCount, 4)
    // The audit: counts only.
    const audit = h.auditAppends.find((e) => e.action === 'project_overview_refresh')
    assert.deepEqual(audit.detail, { projectCount: 2, countedCount: 2, unreadableCount: 0, boundedCount: 0, rowsCreated: 2, rowsUpdated: 0, rowsUnchanged: 0, truncated: false, ledgerReady: false })
    for (const forbidden of [RESPONSIBLE, NOTE, DAY]) assert.ok(!JSON.stringify(h.auditAppends).includes(forbidden))
    // A second refresh re-measures every readable sheet, so 「截至」 moves and every counted row is
    // PATCHED (never re-created): 200 bounded writes at most, one per registry row.
    h.records.calls.length = 0
    const again = await refresh(h, FLOOR)
    assert.deepEqual([again.body.data.rowsCreated, again.body.data.rowsUpdated, again.body.data.rowsUnchanged], [0, 2, 0])
    assert.equal(overviewRows(h).length, 2, 'patched in place, never a second row per project')
    assert.equal(logical(overviewRows(h).find((row) => logical(row, 'projectNo') === PROJECT), 'countsAt'), again.body.data.countsAt)
    // A changed project field lands on the next refresh.
    assert.equal((await putFields(h, FLOOR, { note: '改过的备注' })).statusCode, 200)
    const third = await refresh(h, FLOOR)
    assert.equal(third.statusCode, 200)
    assert.equal(logical(overviewRows(h).find((row) => logical(row, 'projectNo') === PROJECT), 'note'), '改过的备注')
    // UNREADABLE sheets keep the registry's last stamped counts and 「截至」 — and, with nothing else
    // changed, cost no write at all (the unchanged path).
    const realQuery = h.records.queryRecords
    h.records.queryRecords = async (input = {}) => {
      if (input.sheetId !== overviewSheetId(h)) throw new Error('project sheets unreadable')
      return realQuery(input)
    }
    h.records.calls.length = 0
    const fourth = await refresh(h, FLOOR)
    assert.equal(fourth.statusCode, 200, JSON.stringify(fourth.body))
    assert.deepEqual([fourth.body.data.countedCount, fourth.body.data.unreadableCount, fourth.body.data.rowsUpdated, fourth.body.data.rowsUnchanged], [0, 2, 0, 2])
    assert.ok(!h.records.calls.some((c) => c[0] === 'createRecord' || c[0] === 'patchRecord'), 'no overview write when nothing changed')
    assert.equal(logical(overviewRows(h).find((row) => logical(row, 'projectNo') === PROJECT), 'countsAt'), third.body.data.countsAt, '「截至」 keeps the last measurement')
    assert.equal(logical(overviewRows(h).find((row) => logical(row, 'projectNo') === PROJECT), 'rowCount'), 4)
    h.records.queryRecords = realQuery
  } finally { h.restore() }
})

// ── O-11 ───────────────────────────────────────────────────────────────────────────────────────────
test('O-11 last_pull_*: a dry-run stamps previewed, a typed failure stamps refused + code, a stamp failure never fails the pull, switch off stamps nothing', async () => {
  const h = mount()
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
    // A run that throws a typed refusal (the DB-backed column probe finds the sheet incomplete →
    // 422 TARGET_SCHEMA_INCOMPLETE): refused + its code, and the refusal still surfaces.
    const realProbe = h.provisioning.resolveExistingObjectFieldIds
    h.provisioning.resolveExistingObjectFieldIds = async () => ({})
    const failed = await dryRun(h)
    assert.equal(failed.statusCode, 422, JSON.stringify(failed.body))
    assert.equal(failed.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
    row = registryRow(h)
    assert.equal(row.last_pull_outcome, 'refused')
    assert.equal(row.last_pull_code, 'TARGET_SCHEMA_INCOMPLETE')
    h.provisioning.resolveExistingObjectFieldIds = realProbe
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

async function main() {
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
    console.error(`stock-preparation-project-overview.test.cjs FAILED (${failed})`)
    process.exit(1)
  }
  console.log('stock-preparation-project-overview.test.cjs: all assertions passed')
}

main()
