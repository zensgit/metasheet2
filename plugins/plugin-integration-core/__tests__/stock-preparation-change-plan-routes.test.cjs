'use strict'

// Batch-refresh step 5, PR-8 — THE THREE CHANGE-PLAN ROUTES (lib/http-routes.cjs stockPreparationRefreshChangePlan*;
// lib/stock-preparation-refresh-decisions.cjs readChangePlanCurrent / confirmChangePlan / completeChangeReview) on the
// shared project-sheet substrate: the REAL store, the REAL governance reader and the REAL lock over ONE fake db
// (`lockOnRefreshDb`), the REAL dry-run / apply routes over the canonical synthetic S/P source, and a version-faithful
// sheet (records.ts: `expectedVersion` compared, version + 1 per patch). Design §10.3 (1)-(5), §13; plan §9.3 C01-C12;
// register R-63.
//
//   CR-E2E  the whole step-5 loop through the routes: first pull, a person's note, a changed read suspends with two
//           content holds; GET current (the proposal, presence booleans only, ONE audit row, no receipt); GET holds
//           (the receipt); POST confirm (201: the plan confirmed, the holds resolved, the bump `change_plan_confirm`,
//           the audit row on the transaction); the re-preview mints a token bound to the plan; the apply writes ONLY
//           the plan's fields + RUN, each patch carrying the version; the preview answers review_pending (no token,
//           stamped); GET current shows the written plan with the current values and a receipt; POST review (200, the
//           audit row); the next preview mints again.
//   CR-G    the gate on all three: unwired governance 501 after the gate; read / operate / legacy 403, anonymous 401, a
//           tenantless platform admin 403 OPERATOR_SCOPE_TENANT_REQUIRED with zero audit / host work / receipts; the
//           closed allow-lists and the typed confirmProjectNo (400).
//   CR-W2   a continuation store without the change-plan transactions (an older build): 501 decision_store by name.
//   CR-404  the review by id is never an existence oracle: another tenant's plan, another project's plan and an unknown
//           id answer the same bytes.
//   CR-FP   the confirm's fast path (never takes the state row, nothing persisted, no decision audit row): the hold
//           set incomplete, each echo moved, the receipt short, a structure hold (C07), a runbook-only hold (S25), an
//           unfinished execution (RECOVERY_PENDING); the page names each as `proposal.blocked`.
//   CR-CMB  the combined confirm (candidate_content_differs): the history acknowledgement (400), NOT_PILOT without the
//           pilot marker (before the state row); with it 201 — the relationship and the plan in ONE transaction.
//   CR-RV   the review: a confirmed (unwritten) plan STALE not_written; a live writer WRITE_LOCKED; a moved echo; a
//           person's edit after the page => the receipt fingerprint_moved, then content_moved; an open hold BLOCKED; a
//           confirmed plan BLOCKED change_plan_pending; that plan's write absorbs the written one (STALE plan_replaced)
//           and its own review completes (B1: no deadlock).
//   CR-AU   the read order (PR-4 note 0): an audit failure serves no receipt and no body; a not-governed project's page
//           is audited and carries no receipt; its confirm and review refuse.
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const harness = require('./support/stock-preparation-project-sheet-harness.cjs')
const refreshKit = require('./support/stock-preparation-refresh-store-kit.cjs')
const lockKit = require('./support/stock-preparation-project-write-lock-kit.cjs')
const F = require('./support/stock-preparation-continuation-fixtures.cjs')
const tableActions = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const storeModule = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
const { RUN_FIELD_IDS } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { PROJECT_WRITE_LOCK_TABLE, PROJECT_WRITE_ERROR_CODES, sheetWriteScopeKey } = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const { REFRESH_DECISION_ERROR_CODES: CODES, REFRESH_DECISION_AUDIT, READ_RECEIPT_KEY_PREFIX } = require(path.join(LIB, 'stock-preparation-refresh-decisions.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const T = storeModule.REFRESH_STORE_TABLES
const TENANT = 'tenant-cr-a'
const OTHER_TENANT = 'tenant-cr-b'
const PROJECT = F.PROJECT_NO
const BASE = '/api/integration/stock-preparation/projects/:projectNo/refresh'
const PATHS = Object.freeze({
  current: `${BASE}/change-plans/current`,
  confirm: `${BASE}/change-plans/confirm`,
  review: `${BASE}/change-reviews/complete`,
  holds: `${BASE}/holds`,
})
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const APPLY_PATH = '/api/integration/table-actions/:actionId/apply'
const PULLER = Object.freeze({ id: 'u_cr_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const OPERATOR = Object.freeze({ id: 'u_cr_operate', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const READER = Object.freeze({ id: 'u_cr_read', tenantId: TENANT, permissions: [STOCK_PREP_READ] })
const LEGACY_READER = Object.freeze({ id: 'u_cr_legacy', tenantId: TENANT, permissions: ['integration:read'] })
const TENANTLESS_ADMIN = Object.freeze({ id: 'u_cr_platform', roles: ['admin'], permissions: ['integration:admin'] })
const TENANT_ADMIN = Object.freeze({ id: 'u_cr_admin', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] })
const LEASE = Object.freeze({ async acquire() { return { leaseId: 'lease_cr' } }, async release() { return true }, async renew() { return true } })
const FLOOR_NOTE = 'synthetic floor note cr'
const CHANGED_MATERIAL = 'M-ALU-CR'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function errorOf(res) {
  return res.body && res.body.error ? JSON.parse(JSON.stringify(res.body.error)) : {}
}

function dataOf(res) {
  assert.equal(res.statusCode < 300, true, `expected a 2xx, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  return res.body.data
}

function expectRefusal(res, { status = 409, code, reason }) {
  assert.equal(res.statusCode, status, JSON.stringify(res.body))
  const error = errorOf(res)
  assert.equal(error.code, code, JSON.stringify(error))
  if (reason !== undefined) assert.equal(error.details && error.details.reason, reason, JSON.stringify(error.details))
  return error
}

// The canonical second read: PART-A's material and PART-C's usage change on S-001's own order (two content holds).
function changedSource({ material = CHANGED_MATERIAL, partCUsage = 5 } = {}) {
  const parts = F.PARTS.map((part) => (part.OBJ_ID === 'PART-A' ? { ...part, Material: material } : part))
  return F.project({ orders: [{ part: 'S-001', qty: 10 }], parts, boms: { 'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }], 'PART-A': [{ part: 'PART-C', usage: partCUsage }] } })
}

// The project sheet's columns are PHYSICAL ids (`fld_<hash>_<logical>`, the target's fieldIdMap); the suite speaks
// logical ids.
const PHYSICAL_PREFIX = /^fld_[0-9a-z]+_/
function logicalOf(fieldId) {
  return String(fieldId).replace(PHYSICAL_PREFIX, '')
}
function physicalPrefixOf(row) {
  const key = Object.keys(row.data).find((fieldId) => logicalOf(fieldId) === 'componentSourceId')
  return key.slice(0, key.length - 'componentSourceId'.length)
}
function cellOf(row, logical) {
  const key = Object.keys(row.data).find((fieldId) => logicalOf(fieldId) === logical)
  return key === undefined ? undefined : row.data[key]
}

// The main sheet, version-faithful: installed on the harness's records api (the host's write-fence proxy forwards to
// these methods at call time). `writes` logs every host write the routes make: [op, recordId, expectedVersion, LOGICAL
// fields].
function installSheet(h) {
  const rows = []
  const writes = []
  const textOf = (value) => (typeof value === 'object' ? JSON.stringify(value) : String(value))
  h.records.queryRecords = async (input = {}) => {
    const filters = input.filters && typeof input.filters === 'object' ? input.filters : {}
    const hit = (row) => Object.entries(filters).every(([key, wanted]) => {
      const present = Object.prototype.hasOwnProperty.call(row.data, key) && row.data[key] !== undefined
      if (wanted === null || wanted === undefined) return !present
      if (!present || row.data[key] === null) return false
      return Array.isArray(wanted) ? wanted.map(String).includes(textOf(row.data[key])) : textOf(row.data[key]) === String(wanted)
    })
    const matched = rows.filter((row) => row.sheetId === input.sheetId && hit(row))
    const offset = Number.isInteger(input.offset) ? input.offset : 0
    return matched.slice(offset, Number.isInteger(input.limit) ? offset + input.limit : undefined).map(clone)
  }
  h.records.createRecord = async (input = {}) => {
    const record = { id: `rec_cr_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
    rows.push(record)
    writes.push(['createRecord', record.id, null, Object.keys(input.data || {}).map(logicalOf).sort()])
    return clone(record)
  }
  h.records.patchRecord = async (input = {}) => {
    writes.push(['patchRecord', input.recordId, input.expectedVersion === undefined ? null : input.expectedVersion, Object.keys(input.changes || {}).map(logicalOf).sort()])
    const record = rows.find((row) => row.sheetId === input.sheetId && row.id === input.recordId)
    if (!record) throw Object.assign(new Error('Record not found'), { code: 'NOT_FOUND' })
    if (input.expectedVersion !== undefined && record.version !== input.expectedVersion) {
      throw Object.assign(new Error('Record version conflict'), { code: 'VERSION_CONFLICT', name: 'MultitableRecordVersionConflictError' })
    }
    record.version += 1
    record.data = { ...record.data, ...(input.changes || {}) }
    return clone(record)
  }
  return {
    rows,
    writes,
    byComponent: (component) => rows.find((row) => cellOf(row, 'componentSourceId') === component),
    cellOf,
    // A person's edit through the grid (LOGICAL ids): the cells change and the version moves (no route, no lock).
    personEdits(component, changes) {
      const record = rows.find((row) => cellOf(row, 'componentSourceId') === component)
      const prefix = physicalPrefixOf(record)
      record.data = { ...record.data, ...Object.fromEntries(Object.entries(changes).map(([field, value]) => [`${prefix}${field}`, value])) }
      record.version += 1
    },
  }
}

function setPilot(h, enabled) {
  for (const row of h.registryRows()) {
    if (row.project_no !== PROJECT) continue
    row.pilot_enabled_at = enabled ? new Date('2026-10-26T00:00:00Z') : null
    row.pilot_enabled_by = enabled ? 'u_cr_admin' : null
    row.pilot_readiness_version = enabled ? 1 : null
  }
}

function mount({ pilot = true, unwired = false, register = true } = {}) {
  const source = { data: F.firstPullSource() }
  const adapter = {
    async read(input = {}) {
      const rows = Array.isArray(source.data[input.object]) ? source.data[input.object] : []
      const matches = rows.filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
      return { records: matches.map(clone), done: true, nextCursor: null }
    },
  }
  const h = harness.mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    switchOn: true,
    refreshOptions: { lockOnRefreshDb: true },
    serviceExtras: {
      stockPreparationConfirmationDecisionLease: LEASE,
      adapterRegistry: { createAdapter() { return adapter }, listAdapterKinds() { return [] } },
      ...(unwired ? { stockPreparationRefreshGovernance: null } : {}),
    },
  })
  const sheet = installSheet(h)
  const registered = register ? h.seedRegistryRow(PROJECT) : null
  if (register && pilot) setPilot(h, true)
  const sheetId = registered ? registered.sheetId : null
  const scope = { tenantId: TENANT, sheetId, projectNo: PROJECT }
  const env = h.refresh
  // The fake HOST's fence check reads the lock row the routes' REAL lock writes — here on the refresh db
  // (`lockOnRefreshDb`), so the host half is re-wired to look there (the default looks only at the lock kit's dbs).
  if (env) {
    const fenceDb = {
      fenceRowExists: (fence) => env.rows(PROJECT_WRITE_LOCK_TABLE).some((row) => row.scope_key === fence.scopeKey && row.lease_id === fence.leaseId
        && Number(row.fencing_epoch) === Number(fence.fencingEpoch) && row.generation_token === fence.generationToken),
    }
    h.context.api.multitable.records = lockKit.withFakeHostWriteFence(h.records, { lockDb: fenceDb })
  }
  const tableCall = (routePath, body, user = PULLER) => harness.call(h.routes, 'POST', routePath, { user, params: { actionId: tableActions.PLM_STOCK_PREPARATION_ACTION_ID }, body, query: { tenantId: TENANT } })
  const st = {
    h,
    env,
    source,
    sheet,
    sheetId,
    scope,
    scopeKey: sheetId ? sheetWriteScopeKey(sheetId) : null,
    lockRow: () => (env ? env.rows(PROJECT_WRITE_LOCK_TABLE).find((row) => row.scope_key === sheetWriteScopeKey(sheetId)) || null : null),
    holds: () => (env ? env.rows('hold') : []),
    openHolds: () => (env ? env.rows('hold').filter((row) => row.status === 'open') : []),
    plans: () => (env ? env.rows('changePlan') : []),
    continuations: () => (env ? env.rows('continuation') : []),
    executions: () => (env ? env.rows('execution') : []),
    state: () => (env ? env.rows('state')[0] || null : null),
    audits: () => h.auditAppends,
    receipts: () => Array.from(h.context.storage.keys()).filter((key) => String(key).startsWith(READ_RECEIPT_KEY_PREFIX)),
    registryRow: () => h.registryRows().find((row) => row.project_no === PROJECT),
    dryRun: () => tableCall(DRY_RUN_PATH, { parameters: { projectNo: PROJECT } }),
    apply: (dryRunToken) => tableCall(APPLY_PATH, { parameters: { projectNo: PROJECT }, confirm: { dryRunToken } }),
    restore: () => h.restore(),
  }
  return st
}

const call = (st, method, routePath, { user = PULLER, body, query = {}, authenticatedTenantId } = {}) =>
  harness.call(st.h.routes, method, routePath, { user, body, query, params: { projectNo: PROJECT }, ...(authenticatedTenantId !== undefined ? { authenticatedTenantId } : {}) })
const current = (st, query = {}, options = {}) => call(st, 'GET', PATHS.current, { query, ...options })
const listHolds = (st, query = {}, options = {}) => call(st, 'GET', PATHS.holds, { query, ...options })
const confirm = (st, body, options = {}) => call(st, 'POST', PATHS.confirm, { body: { confirmProjectNo: PROJECT, ...body }, ...options })
const review = (st, body, options = {}) => call(st, 'POST', PATHS.review, { body: { confirmProjectNo: PROJECT, ...body }, ...options })

// Whether a request's store transaction took the state row FOR UPDATE (reset `st.env.db.log` before the call).
function stateRowTaken(st) {
  return st.env.db.statements('trx.').some(([method, table]) => method === 'trx.selectOneForUpdate' && table === T.state)
}

// The first pull through the routes (a pilot project with no row yet: a plain preview + apply).
async function firstPull(st) {
  const preview = dataOf(await st.dryRun())
  assert.equal(preview.status, 'ready', JSON.stringify(preview.status))
  assert.ok(preview.dryRunToken)
  dataOf(await st.apply(preview.dryRunToken))
  assert.ok(st.sheet.byComponent('PART-A'), 'the first pull landed')
}

// First pull, a person's note on PART-A, then the changed read previewed: suspended on two content holds.
async function suspendedWorld(options = {}) {
  const st = mount(options)
  await firstPull(st)
  st.sheet.personEdits('PART-A', { notes: FLOOR_NOTE })
  st.source.data = changedSource()
  const suspended = dataOf(await st.dryRun())
  assert.equal(suspended.status, 'suspended')
  assert.equal(st.openHolds().length, 2)
  assert.ok(st.openHolds().every((row) => row.kind === 'content_change'))
  return st
}

// The confirm body exactly as the page offers it (+ a receipt over every page of every content hold).
async function boundConfirmBody(st, { receipt } = {}) {
  const page = dataOf(await current(st))
  const read = receipt || dataOf(await listHolds(st)).readReceipt
  return {
    page,
    body: {
      holdIds: page.proposal.holdIds,
      holdSetFingerprint: page.proposal.holdSetFingerprint,
      planFingerprint: page.proposal.planFingerprint,
      sourceContentDigest: page.proposal.sourceContentDigest,
      readReceipt: read.id,
    },
  }
}

async function confirmedWorld(options = {}) {
  const st = await suspendedWorld(options)
  const { body } = await boundConfirmBody(st)
  const res = await confirm(st, body)
  assert.equal(res.statusCode, 201, JSON.stringify(res.body))
  return { st, confirmed: res.body.data }
}

async function writtenWorld(options = {}) {
  const { st, confirmed } = await confirmedWorld(options)
  const replan = dataOf(await st.dryRun())
  assert.equal(replan.status, 'ready')
  dataOf(await st.apply(replan.dryRunToken))
  assert.equal(st.plans().find((row) => row.id === confirmed.changePlanId).status, 'written')
  return { st, confirmed }
}

// ── CR-E2E ───────────────────────────────────────────────────────────────────────────────────────

test('CR-E2E the whole loop through the routes: page -> receipt -> confirm (201, bump, audit) -> bound preview -> apply (plan fields + RUN, versioned) -> review_pending -> written page + receipt -> review (200) -> the next preview mints', async () => {
  const st = await suspendedWorld()
  try {
    const contentIds = st.openHolds().map((row) => row.id).sort()
    const partA = st.sheet.byComponent('PART-A')
    const partC = st.sheet.byComponent('PART-C')

    // GET current: the proposal (private page), ONE audit row, no receipt (nothing written to review yet).
    const auditsBefore = st.audits().length
    const receiptsBefore = st.receipts().length
    const page = dataOf(await current(st))
    assert.equal(page.refresh.governed, 'pilot')
    assert.equal(page.refresh.pilot, true)
    assert.equal(page.proposal.blocked, null)
    assert.deepEqual(page.proposal.holdIds, contentIds)
    assert.equal(page.proposal.recordCount, 2)
    assert.equal(page.proposal.holdSetFingerprint, st.state().hold_set_fingerprint)
    assert.equal(page.proposal.sourceContentDigest, st.state().last_computation_source_content_digest)
    assert.match(page.proposal.planFingerprint, /^[0-9a-f]{64}$/)
    assert.equal(page.proposal.structureHoldOpen, false)
    assert.equal(page.proposal.runbookHoldOpen, false)
    assert.deepEqual(page.proposal.candidates, [])
    assert.deepEqual(page.proposal.recordPage, { index: 0, count: 1, size: 100, next: null })
    assert.deepEqual(page.current, { confirmed: null, written: null })
    assert.equal(page.readReceipt, null, 'no written plan => no receipt row')
    assert.equal(st.receipts().length, receiptsBefore)
    const recordA = page.proposal.records.find((record) => record.recordId === partA.id)
    assert.ok(recordA, 'the page names PART-A\'s record')
    assert.equal(recordA.present, true)
    assert.equal(recordA.humanColumnsPresent.notes, true, 'C01: the human cell is shown as FILLED')
    assert.equal(JSON.stringify(page).includes(FLOOR_NOTE), false, 'presence only — the human value never leaves')
    assert.ok(JSON.stringify(recordA.fields).includes(CHANGED_MATERIAL), 'the private page shows the change itself')
    const reads = st.audits().slice(auditsBefore)
    assert.equal(reads.length, 1)
    assert.equal(reads[0].action, REFRESH_DECISION_AUDIT.readAction)
    assert.equal(reads[0].mode, REFRESH_DECISION_AUDIT.modes.changePlanRead)
    assert.deepEqual(reads[0].detail, { operation: 'change_plan_read', page: 0, proposalRecords: 2, proposalHolds: 2, pendingPlans: 0, writtenPlan: false, tenantClaimVerified: false })

    // GET holds: the receipt; POST confirm.
    const holdPage = dataOf(await listHolds(st))
    const generationBefore = st.lockRow().generation
    const decisionBefore = st.state().decision_version
    const auditsBeforeConfirm = st.audits().length
    const res = await confirm(st, {
      holdIds: page.proposal.holdIds,
      holdSetFingerprint: page.proposal.holdSetFingerprint,
      planFingerprint: page.proposal.planFingerprint,
      sourceContentDigest: page.proposal.sourceContentDigest,
      readReceipt: holdPage.readReceipt.id,
    })
    assert.equal(res.statusCode, 201, JSON.stringify(res.body))
    const confirmed = res.body.data
    assert.deepEqual(Object.keys(confirmed).sort(), ['changePlanId', 'continuationIds', 'decisionVersion', 'generation', 'holdCount', 'nextStep', 'recordCount', 'state'])
    assert.equal(confirmed.state, 'confirmed_pending_execution')
    assert.equal(confirmed.nextStep, 'preview_again')
    assert.equal(confirmed.recordCount, 2)
    assert.equal(confirmed.holdCount, 2)
    assert.deepEqual(confirmed.continuationIds, [])
    assert.equal(confirmed.decisionVersion, decisionBefore + 1)
    const lockRow = st.lockRow()
    assert.equal(lockRow.generation, generationBefore + 1)
    assert.equal(lockRow.generation_reason, 'change_plan_confirm', 'the in-transaction bump (register ③)')
    assert.equal(confirmed.generation, lockRow.generation)
    const plan = st.plans().find((row) => row.id === confirmed.changePlanId)
    assert.equal(plan.status, 'confirmed')
    assert.equal(plan.confirmed_by, PULLER.id)
    assert.equal(plan.confirmed_generation_token, lockRow.generation_token)
    assert.equal(plan.plan_fingerprint, page.proposal.planFingerprint)
    assert.deepEqual(plan.hold_ids.slice().sort(), contentIds)
    for (const id of contentIds) assert.equal(st.holds().find((row) => row.id === id).status, 'resolved')
    const confirmAudits = st.audits().slice(auditsBeforeConfirm).filter((entry) => entry.action === REFRESH_DECISION_AUDIT.decisionAction)
    assert.equal(confirmAudits.length, 1)
    assert.equal(confirmAudits[0].mode, REFRESH_DECISION_AUDIT.modes.changePlanConfirmed)
    assert.equal(confirmAudits[0].subjectId, plan.id)
    assert.equal(confirmAudits[0].actor, PULLER.id)
    assert.equal(confirmAudits[0].detail.recordCount, 2)
    assert.equal(confirmAudits[0].detail.holdCount, 2)
    assert.equal(JSON.stringify(res.body).includes(CHANGED_MATERIAL), false, 'the confirm answer is values-free')

    // The page now shows the confirmed plan; the proposal is empty.
    const afterConfirm = dataOf(await current(st))
    assert.equal(afterConfirm.proposal.blocked, 'no_content_hold')
    assert.equal(afterConfirm.current.confirmed.id, plan.id)
    assert.equal(afterConfirm.current.confirmed.confirmedBySelf, true)
    assert.equal(afterConfirm.current.written, null)
    assert.equal(afterConfirm.refresh.status, 'confirmed_pending_execution')

    // The re-preview mints a token bound to the plan; the apply writes ONLY the plan's fields + RUN, versioned.
    const replan = dataOf(await st.dryRun())
    assert.equal(replan.status, 'ready')
    assert.ok(replan.dryRunToken)
    const writesBefore = st.sheet.writes.length
    const versions = new Map(st.sheet.rows.map((row) => [row.id, row.version]))
    dataOf(await st.apply(replan.dryRunToken))
    const writes = st.sheet.writes.slice(writesBefore)
    const planFields = new Map(storeModule.__internals.rowToChangePlan(st.plans().find((row) => row.id === plan.id)).recordSet.map((record) => [record.recordId, Object.keys(record.fields)]))
    assert.deepEqual(writes.map(([op, recordId]) => [op, recordId]).sort(), [['patchRecord', partA.id], ['patchRecord', partC.id]].sort(), 'one patch per plan record, no create, nothing else')
    for (const [, recordId, expectedVersion, fields] of writes) {
      assert.equal(expectedVersion, versions.get(recordId), 'register ①: the patch carries the version the in-lease read saw')
      const allowed = new Set([...planFields.get(recordId), ...RUN_FIELD_IDS])
      assert.deepEqual(fields.filter((field) => !allowed.has(field)), [], `only the plan's fields + RUN on ${recordId}`)
      assert.equal(fields.includes('active'), false)
    }
    assert.equal(st.sheet.cellOf(st.sheet.byComponent('PART-A'), 'notes'), FLOOR_NOTE, 'the person\'s note survives the write')
    const written = st.plans().find((row) => row.id === plan.id)
    assert.equal(written.status, 'written')
    const execution = st.executions().find((row) => row.id === written.execution_id)
    assert.ok(execution, 'the plan names the execution that wrote it')
    assert.equal(execution.status, 'succeeded')
    assert.equal(execution.refresh_binding.changePlanId, plan.id)

    // The preview while the written change awaits review: no token, stamped REVIEW_PENDING.
    const pending = dataOf(await st.dryRun())
    assert.equal(pending.status, 'review_pending')
    assert.equal(pending.dryRunToken, null)
    assert.equal(pending.canApply, false)
    assert.deepEqual(pending.refreshReview, { pending: true, pendingReviews: 1, blocksMint: true })
    assert.equal(st.registryRow().last_pull_outcome, 'previewed')
    assert.equal(st.registryRow().last_pull_code, 'STOCK_PREP_REFRESH_REVIEW_PENDING')

    // GET current: the written plan, the values the sheet holds now, the digest the review binds, a receipt.
    const reviewPage = dataOf(await current(st))
    assert.equal(reviewPage.refresh.status, 'change_pending_review')
    const view = reviewPage.current.written
    assert.equal(view.id, plan.id)
    assert.equal(view.contentMatchesWrite, true)
    assert.equal(view.currentContentDigest, written.written_content_digest)
    assert.equal(view.writtenContentDigest, written.written_content_digest)
    const viewA = view.records.find((record) => record.recordId === partA.id)
    assert.ok(Object.values(viewA.fields).some((cell) => cell.after === CHANGED_MATERIAL && cell.current === CHANGED_MATERIAL), 'baseline / before / after / current per field')
    assert.ok(reviewPage.readReceipt, 'a written plan => a receipt over its current diff')
    assert.deepEqual(reviewPage.readReceipt.holds[plan.id], { pageCount: 1, pagesServed: [0], complete: true })
    assert.equal(reviewPage.current.confirmed, null)

    // POST review: 200, reviewed, ONE audit row (no bump).
    const generationBeforeReview = st.lockRow().generation
    const auditsBeforeReview = st.audits().length
    const done = await review(st, { changePlanId: plan.id, contentDigest: view.writtenContentDigest, conclusion: 'handled', readReceipt: reviewPage.readReceipt.id })
    assert.equal(done.statusCode, 200, JSON.stringify(done.body))
    assert.deepEqual(Object.keys(done.body.data).sort(), ['changePlanId', 'decisionVersion', 'nextStep', 'recordCount', 'reviewedContentDigest', 'status'])
    assert.equal(done.body.data.status, 'reviewed')
    assert.equal(done.body.data.reviewedContentDigest, written.written_content_digest)
    const reviewed = st.plans().find((row) => row.id === plan.id)
    assert.equal(reviewed.status, 'reviewed')
    assert.equal(reviewed.reviewed_by, PULLER.id)
    assert.equal(reviewed.review_conclusion, 'handled')
    assert.equal(st.lockRow().generation, generationBeforeReview, 'a review never bumps')
    const reviewAudits = st.audits().slice(auditsBeforeReview).filter((entry) => entry.action === REFRESH_DECISION_AUDIT.decisionAction)
    assert.equal(reviewAudits.length, 1)
    assert.equal(reviewAudits[0].mode, REFRESH_DECISION_AUDIT.modes.changeReviewCompleted)
    assert.equal(reviewAudits[0].subjectId, plan.id)
    assert.equal(reviewAudits[0].detail.sameActorAsConfirm, true, 'C11: the same person may confirm and review — recorded, two rows')
    assert.equal(reviewAudits[0].detail.notesPresent, false)

    // The next preview mints again; the project reads as settled.
    const settled = dataOf(await st.dryRun())
    assert.equal(settled.status, 'ready')
    assert.ok(settled.dryRunToken)
    assert.equal(dataOf(await current(st)).refresh.status === 'change_pending_review', false)
    for (const entry of st.audits()) assert.equal(JSON.stringify(entry).includes(CHANGED_MATERIAL), false, 'every audit row is values-free')
  } finally { st.restore() }
})

// ── CR-G ─────────────────────────────────────────────────────────────────────────────────────────

async function everyRoute(st, options = {}) {
  return [
    ['current', await current(st, {}, options)],
    ['confirm', await confirm(st, { holdIds: ['hold_cr_absent'], holdSetFingerprint: 'a'.repeat(64), planFingerprint: 'b'.repeat(64), sourceContentDigest: 'c'.repeat(64), readReceipt: 'e'.repeat(32) }, options)],
    ['review', await review(st, { changePlanId: 'chp_cr_absent', contentDigest: 'd'.repeat(64), conclusion: 'handled', readReceipt: 'e'.repeat(32) }, options)],
  ]
}

test('CR-G the gate: unwired governance 501 after the gate; read / operate / legacy 403, anonymous 401, a tenantless platform admin 403 with zero audit, host work or receipts; the allow-lists and the typed project number', async () => {
  const unwired = mount({ unwired: true })
  try {
    for (const [route, res] of await everyRoute(unwired)) {
      assert.equal(res.statusCode, 501, `${route}: ${JSON.stringify(res.body)}`)
      assert.equal(errorOf(res).code, CODES.STORE_UNAVAILABLE, route)
      assert.equal(errorOf(res).details.reason, 'governance_service', route)
    }
    assert.deepEqual(unwired.audits(), [])
    for (const [route, res] of await everyRoute(unwired, { user: OPERATOR })) assert.equal(errorOf(res).code, 'FORBIDDEN', `${route}: the gate still comes first`)
  } finally { unwired.restore() }
  const st = mount()
  try {
    for (const [who, user, code, status] of [['reader', READER, 'FORBIDDEN', 403], ['operator', OPERATOR, 'FORBIDDEN', 403], ['legacy', LEGACY_READER, 'FORBIDDEN', 403], ['anonymous', null, 'UNAUTHENTICATED', 401]]) {
      for (const [route, res] of await everyRoute(st, { user })) {
        assert.equal(res.statusCode, status, `${who} ${route}: ${JSON.stringify(res.body)}`)
        assert.equal(errorOf(res).code, code, `${who} ${route}`)
      }
    }
    const hostCalls = st.h.provisioning.calls.length + st.sheet.writes.length
    for (const [route, res] of await everyRoute(st, { user: TENANTLESS_ADMIN })) {
      assert.equal(res.statusCode, 403, `${route}: ${JSON.stringify(res.body)}`)
      assert.equal(errorOf(res).code, 'OPERATOR_SCOPE_TENANT_REQUIRED', route)
    }
    assert.deepEqual(st.audits(), [], 'a refused caller writes no audit row')
    assert.equal(st.receipts().length, 0, 'a refused caller gets no receipt')
    assert.equal(st.h.provisioning.calls.length + st.sheet.writes.length, hostCalls, 'zero host work')
    for (const [route, res] of await everyRoute(st, { user: TENANT_ADMIN })) assert.notEqual(errorOf(res).code, 'FORBIDDEN', `${route}: the tenant admin passes the gate`)
    // The closed allow-lists (an unknown key is 400 before the context) and the typed project number.
    const query = await current(st, { holdId: 'hold_x' })
    expectRefusal(query, { status: 400, code: 'STOCK_PREP_REFRESH_DECISION_REQUEST_INVALID' })
    const extra = await confirm(st, { holdIds: ['h'], holdSetFingerprint: 'a', planFingerprint: 'b', sourceContentDigest: 'c', readReceipt: 'e'.repeat(32), recordIds: ['rec_1'] })
    expectRefusal(extra, { status: 400, code: 'STOCK_PREP_REFRESH_DECISION_REQUEST_INVALID' })
    const reviewExtra = await review(st, { changePlanId: 'chp_1', contentDigest: 'd', conclusion: 'handled', readReceipt: 'e'.repeat(32), status: 'reviewed' })
    expectRefusal(reviewExtra, { status: 400, code: 'STOCK_PREP_REFRESH_DECISION_REQUEST_INVALID' })
    const typed = await call(st, 'POST', PATHS.confirm, { body: { confirmProjectNo: 'PRJ-OTHER', holdIds: ['h'], holdSetFingerprint: 'a', planFingerprint: 'b', sourceContentDigest: 'c', readReceipt: 'e'.repeat(32) } })
    assert.equal(expectRefusal(typed, { status: 400, code: 'STOCK_PREP_REFRESH_DECISION_REQUEST_INVALID' }).details.field, 'confirmProjectNo')
    const typedReview = await call(st, 'POST', PATHS.review, { body: { changePlanId: 'chp_1', contentDigest: 'd', conclusion: 'handled', readReceipt: 'e'.repeat(32) } })
    assert.equal(expectRefusal(typedReview, { status: 400, code: 'STOCK_PREP_REFRESH_DECISION_REQUEST_INVALID' }).details.field, 'confirmProjectNo')
    // Body normalizers (field named, before any store read).
    for (const [body, field] of [
      [{ holdIds: [], holdSetFingerprint: 'a', planFingerprint: 'b', sourceContentDigest: 'c', readReceipt: 'e'.repeat(32) }, 'holdIds'],
      [{ holdIds: ['h', 'h'], holdSetFingerprint: 'a', planFingerprint: 'b', sourceContentDigest: 'c', readReceipt: 'e'.repeat(32) }, 'holdIds'],
      [{ holdIds: ['h'], planFingerprint: 'b', sourceContentDigest: 'c', readReceipt: 'e'.repeat(32) }, 'holdSetFingerprint'],
      [{ holdIds: ['h'], holdSetFingerprint: 'a', sourceContentDigest: 'c', readReceipt: 'e'.repeat(32) }, 'planFingerprint'],
      [{ holdIds: ['h'], holdSetFingerprint: 'a', planFingerprint: 'b', readReceipt: 'e'.repeat(32) }, 'sourceContentDigest'],
      [{ holdIds: ['h'], holdSetFingerprint: 'a', planFingerprint: 'b', sourceContentDigest: 'c' }, 'readReceipt'],
      [{ holdIds: ['h'], holdSetFingerprint: 'a', planFingerprint: 'b', sourceContentDigest: 'c', readReceipt: 'e'.repeat(32), candidates: [{ holdId: 'h' }] }, 'candidates[0]'],
      [{ holdIds: ['h'], holdSetFingerprint: 'a', planFingerprint: 'b', sourceContentDigest: 'c', readReceipt: 'e'.repeat(32), candidates: [{ holdId: 'h', candidateId: 'c', basis: { kind: 'other' } }] }, 'candidates[0].basis.kind'],
    ]) {
      assert.equal(expectRefusal(await confirm(st, body), { status: 400, code: CODES.REQUEST_INVALID }).details.field, field, JSON.stringify(body))
    }
    for (const [body, field] of [
      [{ contentDigest: 'd', conclusion: 'handled', readReceipt: 'e'.repeat(32) }, 'changePlanId'],
      [{ changePlanId: 'chp_1', conclusion: 'handled', readReceipt: 'e'.repeat(32) }, 'contentDigest'],
      [{ changePlanId: 'chp_1', contentDigest: 'd', conclusion: 'approved', readReceipt: 'e'.repeat(32) }, 'conclusion'],
      [{ changePlanId: 'chp_1', contentDigest: 'd', conclusion: 'handled', notes: 7, readReceipt: 'e'.repeat(32) }, 'notes'],
      [{ changePlanId: 'chp_1', contentDigest: 'd', conclusion: 'handled' }, 'readReceipt'],
    ]) {
      assert.equal(expectRefusal(await review(st, body), { status: 400, code: CODES.REQUEST_INVALID }).details.field, field, JSON.stringify(body))
    }
    for (const [query, field] of [[{ recordLimit: '0' }, 'recordLimit'], [{ recordLimit: '201' }, 'recordLimit'], [{ recordCursor: '-1' }, 'recordCursor'], [{ receipt: 'not-a-receipt' }, 'receipt'], [{ recordCursor: '1' }, 'recordCursor']]) {
      assert.equal(expectRefusal(await current(st, query), { status: 400, code: CODES.REQUEST_INVALID }).details.field, field, JSON.stringify(query))
    }
  } finally { st.restore() }
})

test('CR-W2 a continuation store WITHOUT the change-plan transactions (an older store build): all three routes 501 STOCK_PREP_REFRESH_STORE_UNAVAILABLE decision_store after the gate and the scope, zero audit rows', async () => {
  const wiring = require('./support/stock-preparation-refresh-governance-wiring.cjs')
  const env = wiring.createRefreshGovernanceEnv({ lock: lockKit.createInMemoryProjectWriteLock({ timers: 'real' }).lock })
  for (const missing of ['readChangePlan', 'confirmChangePlan', 'completeChangeReview']) {
    const older = { ...env.store }
    delete older[missing]
    const h = harness.mountProjectSheetRoutes({
      tenantId: TENANT,
      projectNo: PROJECT,
      switchOn: true,
      serviceExtras: { stockPreparationConfirmationDecisionLease: LEASE, stockPreparationRefreshGovernance: env.governance, stockPreparationContinuationStore: older },
    })
    try {
      h.seedRegistryRow(PROJECT)
      const st = { h }
      for (const [route, res] of await everyRoute(st)) {
        assert.equal(res.statusCode, 501, `${missing} ${route}: ${JSON.stringify(res.body)}`)
        assert.equal(errorOf(res).code, CODES.STORE_UNAVAILABLE, `${missing} ${route}`)
        assert.equal(errorOf(res).details.reason, 'decision_store', `${missing} ${route}`)
      }
      assert.deepEqual(h.auditAppends, [], `${missing}: no audit row`)
      for (const [route, res] of await everyRoute(st, { user: OPERATOR })) assert.equal(errorOf(res).code, 'FORBIDDEN', `${missing} ${route}: the gate still comes first`)
    } finally { h.restore() }
  }
})

// ── CR-404 ───────────────────────────────────────────────────────────────────────────────────────

test('CR-404 the review by id is never an existence oracle: another tenant\'s plan, another project\'s plan and an unknown id answer the SAME bytes (404 STOCK_PREP_CHANGE_PLAN_NOT_FOUND), with no decision audit row', async () => {
  const { st, confirmed } = await writtenWorld()
  try {
    const own = st.plans().find((row) => row.id === confirmed.changePlanId)
    const table = st.env.db.tables.get(T.changePlan)
    table.set('chp_cr_foreign_tenant', { ...clone(own), id: 'chp_cr_foreign_tenant', tenant_id: OTHER_TENANT, sheet_id: 'sheet_cr_other', project_no: 'PRJ-CR-OTHER', written_at: own.written_at, confirmed_at: own.confirmed_at, created_at: own.created_at, updated_at: own.updated_at })
    table.set('chp_cr_other_project', { ...clone(own), id: 'chp_cr_other_project', project_no: 'PRJ-CR-OTHER', written_at: own.written_at, confirmed_at: own.confirmed_at, created_at: own.created_at, updated_at: own.updated_at })
    const page = dataOf(await current(st))
    const bodyFor = (changePlanId) => ({ changePlanId, contentDigest: page.current.written.writtenContentDigest, conclusion: 'handled', readReceipt: page.readReceipt.id })
    const auditsBefore = st.audits().length
    const answers = []
    for (const id of ['chp_cr_unknown', 'chp_cr_foreign_tenant', 'chp_cr_other_project']) {
      const res = await review(st, bodyFor(id))
      expectRefusal(res, { status: 404, code: CODES.CHANGE_PLAN_NOT_FOUND })
      answers.push(JSON.stringify(res.body))
    }
    assert.equal(new Set(answers).size, 1, 'byte-identical answers')
    assert.equal(st.audits().slice(auditsBefore).filter((entry) => entry.action === REFRESH_DECISION_AUDIT.decisionAction).length, 0)
    assert.equal(st.plans().find((row) => row.id === own.id).status, 'written', 'the own plan is untouched')
  } finally { st.restore() }
})

// ── CR-FP ────────────────────────────────────────────────────────────────────────────────────────

function assertNothingDecided(st, before, label) {
  assert.equal(stateRowTaken(st), false, `${label}: decided from the consult, the state row never taken`)
  assert.equal(st.plans().length, before.plans, `${label}: no plan row`)
  assert.equal(st.openHolds().length, before.openHolds, `${label}: the holds stay open`)
  assert.equal(st.audits().filter((entry) => entry.action === REFRESH_DECISION_AUDIT.decisionAction).length, before.decisionAudits, `${label}: no decision audit row`)
  assert.equal(st.lockRow().generation, before.generation, `${label}: no bump`)
}

function snapshotOf(st) {
  return { plans: st.plans().length, openHolds: st.openHolds().length, decisionAudits: st.audits().filter((entry) => entry.action === REFRESH_DECISION_AUDIT.decisionAction).length, generation: st.lockRow().generation }
}

// A computation's reconcile through the store (the digest is the one the suspended preview computed: a seed helper's
// own reconcile records none).
async function reconcileWith(st, holds, { sourceContentDigest, ...extra } = {}) {
  const state = st.state()
  return st.env.store.reconcileHolds({
    ...st.scope,
    decisionVersionObserved: state.decision_version,
    holds,
    computation: { lane: 'small_preview', suspended: holds.length > 0, generationToken: null, sourceContentDigest },
    ...extra,
  }, { auditWithin: async () => {} })
}

test('CR-FP the confirm\'s fast path decides from the consult and never takes the state row: an incomplete set, each echo moved, a short receipt, a structure hold (C07), a runbook-only hold (S25), an unfinished execution — nothing persisted, no bump, no decision audit row; the page names each as proposal.blocked', async () => {
  const st = await suspendedWorld()
  try {
    const { page, body } = await boundConfirmBody(st)
    const [first, second] = page.proposal.holdIds
    const digest = page.proposal.sourceContentDigest
    const before = snapshotOf(st)
    const cases = [
      ['one hold of two', { ...body, holdIds: [first] }, CODES.CHANGE_PLAN_STALE, 'hold_set_incomplete'],
      ['an unknown hold', { ...body, holdIds: [first, 'hold_cr_bogus'] }, CODES.CHANGE_PLAN_STALE, 'hold_set_incomplete'],
      ['the hold set moved', { ...body, holdSetFingerprint: 'f'.repeat(64) }, CODES.CHANGE_PLAN_STALE, 'hold_set_moved'],
      ['the source moved', { ...body, sourceContentDigest: 'f'.repeat(64) }, CODES.CHANGE_PLAN_STALE, 'source_moved'],
      ['the plan moved', { ...body, planFingerprint: 'f'.repeat(64) }, CODES.CHANGE_PLAN_STALE, 'plan_fingerprint'],
      ['a candidate on a plain set', { ...body, candidates: [{ holdId: first, candidateId: 'x'.repeat(64), basis: { kind: 'puller_confirmed_same_demand' } }] }, CODES.CHANGE_PLAN_STALE, 'candidate_set'],
      ['an unknown receipt', { ...body, readReceipt: 'f'.repeat(32) }, CODES.READ_RECEIPT_INCOMPLETE, 'receipt_absent'],
    ]
    for (const [label, input, code, reason] of cases) {
      st.env.db.log.length = 0
      expectRefusal(await confirm(st, input), { code, reason })
      assertNothingDecided(st, before, label)
    }
    // A receipt over ONE of the two holds (GET holds?holdId=…): the other is not in it.
    const half = dataOf(await listHolds(st, { holdId: first })).readReceipt
    st.env.db.log.length = 0
    const short = expectRefusal(await confirm(st, { ...body, readReceipt: half.id }), { code: CODES.READ_RECEIPT_INCOMPLETE, reason: 'hold_not_in_receipt' })
    assert.equal(short.details.holdId, second)
    assertNothingDecided(st, before, 'a half receipt')

    // C07: a STRUCTURE hold beside the content holds (a legacy lineage mismatch on a governed project).
    const contentHolds = st.openHolds().map(storeModule.__internals.rowToHold)
    const structure = { kind: 'structure_change', confirmable: false, notConfirmableReason: 'phase_2', subject: { keyDigest: 's'.repeat(64) }, detail: { recordId: st.sheet.byComponent('PART-B').id, key: 'k_cr_structure', changedFields: ['componentSourceId'] } }
    structure.fingerprint = pairing.holdFingerprint(structure)
    await reconcileWith(st, [...contentHolds, structure], { sourceContentDigest: digest })
    const structured = dataOf(await current(st))
    assert.equal(structured.proposal.blocked, 'structure_change_present')
    assert.equal(structured.proposal.structureHoldOpen, true)
    const withStructure = await boundConfirmBody(st)
    const beforeStructure = snapshotOf(st)
    st.env.db.log.length = 0
    assert.equal(expectRefusal(await confirm(st, withStructure.body), { code: CODES.CHANGE_PLAN_STRUCTURE_CHANGE_PRESENT }).details.holdCount, 1)
    assertNothingDecided(st, beforeStructure, 'C07')
    await reconcileWith(st, contentHolds, { sourceContentDigest: digest })
    assert.equal(st.openHolds().length, 2)

    // S25: a relationship escalated to specialist repair keeps a runbook-only hold open.
    const fixture = await refreshKit.candidateHoldFixture()
    await st.env.seedEscalatedContinuation(st.scope, fixture.hold, { sourceIdentity: fixture.sourceIdentity })
    const runbookRow = st.openHolds().find((row) => row.runbook_only === true)
    assert.ok(runbookRow, 'the escalation left a runbook-only hold open')
    await reconcileWith(st, [...contentHolds, storeModule.__internals.rowToHold(runbookRow)], { sourceContentDigest: digest })
    const runbookPage = dataOf(await current(st))
    assert.equal(runbookPage.proposal.blocked, 'runbook_only_hold_open')
    assert.equal(runbookPage.proposal.runbookHoldOpen, true)
    const withRunbook = await boundConfirmBody(st)
    const beforeRunbook = snapshotOf(st)
    st.env.db.log.length = 0
    expectRefusal(await confirm(st, withRunbook.body), { code: CODES.CHANGE_PLAN_NOT_ALLOWED, reason: 'runbook_only_hold_open' })
    assertNothingDecided(st, beforeRunbook, 'S25')
  } finally { st.restore() }
  // RECOVERY_PENDING: an execution that did not finish cleanly.
  const rp = await suspendedWorld()
  try {
    const { body } = await boundConfirmBody(rp)
    await rp.env.seedExecution(rp.scope, { status: 'failed' })
    assert.equal(dataOf(await current(rp)).proposal.blocked, 'recovery_pending')
    const before = snapshotOf(rp)
    rp.env.db.log.length = 0
    const error = expectRefusal(await confirm(rp, body), { code: CODES.RECOVERY_PENDING })
    assert.equal(error.details.openExecutions, 1)
    assertNothingDecided(rp, before, 'RECOVERY_PENDING')
  } finally { rp.restore() }
})

// ── CR-CMB ───────────────────────────────────────────────────────────────────────────────────────

test('CR-CMB the combined confirm (candidate_content_differs): the unknown history must be acknowledged (400); NOT_PILOT without the pilot marker, before the state row; with it 201 — the relationship, its members and the plan in ONE transaction with ONE bump', async () => {
  const st = mount()
  try {
    await firstPull(st)
    st.source.data = F.secondPullSource({ edge: 3 })
    const suspended = dataOf(await st.dryRun())
    assert.equal(suspended.status, 'suspended')
    const candidateRows = st.openHolds().filter((row) => row.kind === 'candidate_content_differs')
    assert.equal(candidateRows.length, 1, JSON.stringify(st.openHolds().map((row) => row.kind)))
    const { page, body } = await boundConfirmBody(st)
    assert.equal(page.proposal.blocked, null, JSON.stringify(page.proposal.blocked))
    assert.deepEqual(page.proposal.candidates.map((entry) => entry.holdId), [candidateRows[0].id])
    const candidate = page.proposal.candidates[0]
    assert.equal(candidate.candidateId, candidateRows[0].pairing_fingerprint)
    assert.equal(candidate.history, 'history_unknown')
    const decision = { holdId: candidate.holdId, candidateId: candidate.candidateId, basis: { kind: 'puller_confirmed_same_demand', note: 'synthetic basis' } }
    const before = snapshotOf(st)
    const missing = await confirm(st, { ...body })
    expectRefusal(missing, { code: CODES.CHANGE_PLAN_STALE, reason: 'candidate_set' })
    const unacknowledged = await confirm(st, { ...body, candidates: [decision] })
    assert.equal(expectRefusal(unacknowledged, { status: 400, code: CODES.REQUEST_INVALID }).details.field, 'candidates.acknowledge.historyUnknown')
    const wrongCandidate = await confirm(st, { ...body, candidates: [{ ...decision, candidateId: 'x'.repeat(64), acknowledge: { historyUnknown: true } }] })
    expectRefusal(wrongCandidate, { code: CODES.CHANGE_PLAN_STALE, reason: 'candidate' })
    setPilot(st.h, false)
    st.env.db.log.length = 0
    const notPilot = await confirm(st, { ...body, candidates: [{ ...decision, acknowledge: { historyUnknown: true } }] })
    expectRefusal(notPilot, { code: CODES.NOT_PILOT })
    assertNothingDecided(st, before, 'NOT_PILOT')
    setPilot(st.h, true)
    const generationBefore = st.lockRow().generation
    const done = await confirm(st, { ...body, candidates: [{ ...decision, acknowledge: { historyUnknown: true } }] })
    assert.equal(done.statusCode, 201, JSON.stringify(done.body))
    assert.equal(done.body.data.continuationIds.length, 1)
    assert.equal(st.lockRow().generation, generationBefore + 1, 'ONE bump for the relationship and the plan')
    assert.equal(st.lockRow().generation_reason, 'change_plan_confirm')
    const relationship = st.continuations().find((row) => row.id === done.body.data.continuationIds[0])
    assert.equal(relationship.status, 'active')
    assert.equal(relationship.confirmed_by, PULLER.id)
    assert.equal(relationship.basis_note, 'synthetic basis')
    const plan = st.plans().find((row) => row.id === done.body.data.changePlanId)
    assert.deepEqual(plan.continuation_ids, done.body.data.continuationIds)
    assert.equal(plan.confirmed_generation_token, relationship.confirmed_generation_token, 'the same transaction\'s bump')
    // The re-preview binds the combined plan.
    const replan = dataOf(await st.dryRun())
    assert.equal(replan.status, 'ready')
    assert.ok(replan.dryRunToken)
  } finally { st.restore() }
})

// ── CR-RV ────────────────────────────────────────────────────────────────────────────────────────

test('CR-RV the review: a confirmed plan is not reviewable (not_written); a live writer WRITE_LOCKED; a moved echo; a person\'s edit after the page => the receipt fingerprint_moved, then content_moved; an open hold BLOCKED; a confirmed plan BLOCKED change_plan_pending; its write absorbs the written plan (STALE plan_replaced) and its own review completes', async () => {
  const { st, confirmed } = await confirmedWorld()
  try {
    // Not written yet.
    const early = await review(st, { changePlanId: confirmed.changePlanId, contentDigest: 'd'.repeat(64), conclusion: 'handled', readReceipt: 'e'.repeat(32) })
    assert.equal(expectRefusal(early, { code: CODES.CHANGE_REVIEW_STALE, reason: 'not_written' }).details.status, 'confirmed')
    const replan = dataOf(await st.dryRun())
    dataOf(await st.apply(replan.dryRunToken))
    const page = dataOf(await current(st))
    const view = page.current.written
    const bodyOf = (overrides = {}) => ({ changePlanId: view.id, contentDigest: view.writtenContentDigest, conclusion: 'handled', readReceipt: page.readReceipt.id, ...overrides })

    // A live writer holds the sheet: the review does not read it.
    const lock = st.env.lock()
    const grant = await lock.acquire(st.scopeKey, { purpose: 'small_apply', runId: 'cr-rv', tenantId: TENANT })
    expectRefusal(await review(st, bodyOf()), { code: PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED })
    await lock.createGuard(grant).release()

    // A moved echo.
    expectRefusal(await review(st, bodyOf({ contentDigest: 'f'.repeat(64) })), { code: CODES.CHANGE_REVIEW_STALE, reason: 'echo_moved' })

    // A person edits a written field after the page: the receipt no longer vouches for what the sheet shows.
    st.sheet.personEdits('PART-A', { material: 'M-PERSON-CR' })
    const moved = await review(st, bodyOf())
    expectRefusal(moved, { code: CODES.CHANGE_REVIEW_READ_RECEIPT_INCOMPLETE, reason: 'fingerprint_moved' })
    const reread = dataOf(await current(st))
    assert.equal(reread.current.written.contentMatchesWrite, false)
    assert.notEqual(reread.current.written.currentContentDigest, view.writtenContentDigest)
    expectRefusal(await review(st, bodyOf({ readReceipt: reread.readReceipt.id })), { code: CODES.CHANGE_REVIEW_STALE, reason: 'content_moved' })
    assert.equal(st.plans().find((row) => row.id === view.id).status, 'written', 'the obligation stays')

    // The next read opens a hold (the person's value differs from the source): the review is BLOCKED.
    const suspended = dataOf(await st.dryRun())
    assert.equal(suspended.status, 'suspended')
    expectRefusal(await review(st, bodyOf({ readReceipt: reread.readReceipt.id })), { code: CODES.CHANGE_REVIEW_BLOCKED, reason: 'hold_open' })

    // A new plan B over that hold: the written plan W is BLOCKED change_plan_pending while B is confirmed.
    const next = await boundConfirmBody(st)
    const confirmedB = await confirm(st, next.body)
    assert.equal(confirmedB.statusCode, 201, JSON.stringify(confirmedB.body))
    expectRefusal(await review(st, bodyOf({ readReceipt: reread.readReceipt.id })), { code: CODES.CHANGE_REVIEW_BLOCKED, reason: 'change_plan_pending' })

    // B1 (no deadlock): B's preview mints although W awaits review; B's write absorbs W.
    const replanB = dataOf(await st.dryRun())
    assert.equal(replanB.status, 'ready')
    assert.ok(replanB.dryRunToken)
    dataOf(await st.apply(replanB.dryRunToken))
    const w = st.plans().find((row) => row.id === view.id)
    const b = st.plans().find((row) => row.id === confirmedB.body.data.changePlanId)
    assert.equal(w.status, 'superseded')
    assert.equal(w.superseded_by, b.id)
    assert.equal(b.status, 'written')
    assert.ok(b.absorbed_change_plan_ids.includes(w.id))
    expectRefusal(await review(st, bodyOf({ readReceipt: reread.readReceipt.id })), { code: CODES.CHANGE_REVIEW_STALE, reason: 'plan_replaced' })
    const pageB = dataOf(await current(st))
    assert.equal(pageB.current.written.id, b.id)
    assert.deepEqual(pageB.current.written.absorbedChangePlanIds, [w.id])
    const viewC = pageB.current.written.records.find((record) => record.recordId === st.sheet.byComponent('PART-C').id)
    assert.ok(viewC && Object.keys(viewC.fields).length > 0 && Object.values(viewC.fields).every((cell) => cell.reviewOnly === true), 'the written plan\'s unreviewed PART-C change rides B as review-only (B1: nothing written escapes review)')
    assert.equal(pageB.current.written.contentMatchesWrite, true)
    const doneB = await review(st, { changePlanId: b.id, contentDigest: pageB.current.written.writtenContentDigest, conclusion: 'handled_with_notes', notes: 'synthetic review note', readReceipt: pageB.readReceipt.id })
    assert.equal(doneB.statusCode, 200, JSON.stringify(doneB.body))
    assert.equal(st.plans().find((row) => row.id === b.id).review_notes, 'synthetic review note')
    const audit = st.audits().filter((entry) => entry.mode === REFRESH_DECISION_AUDIT.modes.changeReviewCompleted)
    assert.equal(audit.length, 1)
    assert.equal(audit[0].detail.notesPresent, true)
    assert.equal(JSON.stringify(audit).includes('synthetic review note'), false, 'the notes stay on the private row')
    assert.equal(dataOf(await st.dryRun()).status, 'ready')
  } finally { st.restore() }
})

// ── CR-AU ────────────────────────────────────────────────────────────────────────────────────────

test('CR-AU the read order: an audit failure on the page serves no receipt and no body; a not-governed project\'s page is audited with no receipt, and its confirm / review refuse', async () => {
  const { st } = await writtenWorld()
  try {
    const store = st.h.services.stockPreparationAuditStore
    const realAppend = store.append
    store.append = async (entry) => {
      if (entry.mode === REFRESH_DECISION_AUDIT.modes.changePlanRead) throw Object.assign(new Error('audit store down'), { code: 'AUDIT_DOWN' })
      return realAppend(entry)
    }
    const receiptsBefore = st.receipts().length
    const res = await current(st)
    assert.ok(res.statusCode >= 500, JSON.stringify(res.body))
    assert.equal(res.body.data, undefined, 'no body')
    assert.equal(st.receipts().length, receiptsBefore, 'the receipt is recorded only AFTER the audit row')
    store.append = realAppend
    const ok = dataOf(await current(st))
    assert.ok(ok.readReceipt)
    assert.equal(st.receipts().length, receiptsBefore + 1)
  } finally { st.restore() }
  // A registered project that is NOT governed (no pilot, no row): audited, no receipt, nothing to confirm or review.
  const ng = mount({ pilot: false })
  try {
    const auditsBefore = ng.audits().length
    const page = dataOf(await current(ng))
    assert.equal(page.refresh.status, 'not_governed')
    assert.equal(page.proposal.blocked, 'no_content_hold')
    assert.equal(page.readReceipt, null)
    assert.equal(ng.receipts().length, 0)
    assert.equal(ng.audits().length, auditsBefore + 1)
    assert.equal(ng.sheet.writes.length, 0)
    expectRefusal(await confirm(ng, { holdIds: ['hold_cr_x'], holdSetFingerprint: 'a', planFingerprint: 'b', sourceContentDigest: 'c', readReceipt: 'e'.repeat(32) }), { code: CODES.CHANGE_PLAN_STALE, reason: 'no_content_hold' })
    expectRefusal(await review(ng, { changePlanId: 'chp_cr_x', contentDigest: 'd', conclusion: 'handled', readReceipt: 'e'.repeat(32) }), { status: 404, code: CODES.CHANGE_PLAN_NOT_FOUND })
    assert.equal(ng.env.stepFourRowCount(), 0, 'no read wrote a step-4 row')
  } finally { ng.restore() }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-change-plan-routes.test.cjs', tests)
