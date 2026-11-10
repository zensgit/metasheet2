'use strict'

// 备料 batch-refresh step 6a-2 (S6-2; register row R-91) — the RECOVERY ROUTES through the real route table (design §3.5,
// §3.8, §5.1; RR-01). The project-sheet harness mounts every route with the REAL governance, the REAL continuation store
// and the REAL write lock on ONE refresh db (`lockOnRefreshDb`: the close's in-transaction holder assert reads the lock
// row on the close's own handle), a fake host that declares and enforces the write fence, and a fake source.
//
//   RR-01  tiers: list / recover are PULL; close-unverified is ADMIN (a puller is 403 at its gate); the floor (read +
//          operate) is 403 on all three; a tenantless platform admin is refused by the operator scope; zero records IO
//   RR-02  the list: values-free items (no principal ids), `recoverable`, no `batch` key while 批次标识 is off; audited
//          (project_board_read / execution_list_read) before the answer
//   RR-03  recover: the advisory prelude refuses 404 / NOT_UNFINISHED BEFORE any lease (the lock row untouched); verify
//          answers the report + one audited page and bumps nothing; close takes the `recovery_verify` lease, closes under
//          it, releases, THEN bumps `recovery_closed` (generationBumped: true); the audit row exception_resolve /
//          execution_verified_closed; the retry preview mints and the apply writes only the missing rows
//   RR-04  the closed bodies and the typed project number (400 before any IO)
//   RR-05  close-unverified (ADMIN): inspect (no source read) -> close with the echo, the acknowledgement and a ticket
//          handle -> unknown / runbook; audit execution_closed_unverified
// Every value is synthetic.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const harness = require('./support/stock-preparation-project-sheet-harness.cjs')
const lockKit = require('./support/stock-preparation-project-write-lock-kit.cjs')
const F = require('./support/stock-preparation-continuation-fixtures.cjs')
const tableActions = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const storeModule = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
const { STOCK_PREP_ADMIN, STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { PROJECT_WRITE_LOCK_TABLE, sheetWriteScopeKey } = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const { REFRESH_DECISION_AUDIT } = require(path.join(LIB, 'stock-preparation-refresh-decisions.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const CODES = storeModule.REFRESH_STORE_ERROR_CODES
const TENANT = 'tenant-rr-a'
const PROJECT = F.PROJECT_NO
const BASE = '/api/integration/stock-preparation/projects/:projectNo/refresh/executions'
const PATHS = Object.freeze({ list: BASE, recover: `${BASE}/:executionId/recover`, closeUnverified: `${BASE}/:executionId/close-unverified` })
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const APPLY_PATH = '/api/integration/table-actions/:actionId/apply'
const PULLER = Object.freeze({ id: 'u_rr_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const OPERATOR = Object.freeze({ id: 'u_rr_operate', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const ADMIN = Object.freeze({ id: 'u_rr_admin', tenantId: TENANT, permissions: [STOCK_PREP_ADMIN] })
const TENANTLESS_ADMIN = Object.freeze({ id: 'u_rr_platform', roles: ['admin'], permissions: ['integration:admin'] })
const LEASE = Object.freeze({ async acquire() { return { leaseId: 'lease_rr' } }, async release() { return true }, async renew() { return true } })

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function dataOf(res) {
  assert.equal(res.statusCode < 300, true, `expected a 2xx, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  return res.body.data
}

function errorOf(res) {
  return res.body && res.body.error ? JSON.parse(JSON.stringify(res.body.error)) : {}
}

function expectRefusal(res, { status, code, reason }) {
  assert.equal(res.statusCode, status, JSON.stringify(res.body))
  const error = errorOf(res)
  if (code !== undefined) assert.equal(error.code, code, JSON.stringify(error))
  if (reason !== undefined) assert.equal(error.details && error.details.reason, reason, JSON.stringify(error.details))
  return error
}

function installSheet(h) {
  const rows = []
  const sheet = { rows, failCreates: 0, writes: 0, queries: 0 }
  const textOf = (value) => (typeof value === 'object' ? JSON.stringify(value) : String(value))
  h.records.queryRecords = async (input = {}) => {
    sheet.queries += 1
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
    sheet.writes += 1
    if (sheet.failCreates > 0) {
      sheet.failCreates -= 1
      throw Object.assign(new Error('synthetic create failure'), { code: 'SYN_CREATE_FAILED' })
    }
    const record = { id: `rec_rr_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
    rows.push(record)
    return clone(record)
  }
  h.records.patchRecord = async (input = {}) => {
    sheet.writes += 1
    const record = rows.find((row) => row.sheetId === input.sheetId && row.id === input.recordId)
    record.version += 1
    record.data = { ...record.data, ...(input.changes || {}) }
    return clone(record)
  }
  return sheet
}

function mount() {
  const source = { data: F.firstPullSource(), reads: 0 }
  const adapter = {
    async read(input = {}) {
      source.reads += 1
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
    },
  })
  const sheet = installSheet(h)
  const registered = h.seedRegistryRow(PROJECT)
  for (const row of h.registryRows()) {
    if (row.project_no !== PROJECT) continue
    row.pilot_enabled_at = new Date('2026-11-09T00:00:00Z')
    row.pilot_enabled_by = 'u_rr_admin'
    row.pilot_readiness_version = 1
  }
  const env = h.refresh
  const fenceDb = {
    fenceRowExists: (fence) => env.rows(PROJECT_WRITE_LOCK_TABLE).some((row) => row.scope_key === fence.scopeKey && row.lease_id === fence.leaseId
      && Number(row.fencing_epoch) === Number(fence.fencingEpoch) && row.generation_token === fence.generationToken),
  }
  h.context.api.multitable.records = lockKit.withFakeHostWriteFence(h.records, { lockDb: fenceDb })
  const tableCall = (routePath, body) => harness.call(h.routes, 'POST', routePath, { user: PULLER, params: { actionId: tableActions.PLM_STOCK_PREPARATION_ACTION_ID }, body, query: { tenantId: TENANT } })
  const st = {
    h, env, source, sheet,
    sheetId: registered.sheetId,
    lockRow: () => env.rows(PROJECT_WRITE_LOCK_TABLE).find((row) => row.scope_key === sheetWriteScopeKey(registered.sheetId)) || null,
    executions: () => env.rows('execution'),
    audits: () => h.auditAppends,
    dryRun: () => tableCall(DRY_RUN_PATH, { parameters: { projectNo: PROJECT } }),
    apply: (dryRunToken) => tableCall(APPLY_PATH, { parameters: { projectNo: PROJECT }, confirm: { dryRunToken } }),
  }
  return st
}

const call = (st, method, routePath, { user = PULLER, body, query = {}, executionId } = {}) =>
  harness.call(st.h.routes, method, routePath, { user, body, query, params: { projectNo: PROJECT, ...(executionId ? { executionId } : {}) } })
const list = (st, options = {}) => call(st, 'GET', PATHS.list, options)
const recover = (st, executionId, body, options = {}) => call(st, 'POST', PATHS.recover, { executionId, body: { confirmProjectNo: PROJECT, ...body }, ...options })
const closeUnverified = (st, executionId, body, options = {}) => call(st, 'POST', PATHS.closeUnverified, { user: ADMIN, executionId, body: { confirmProjectNo: PROJECT, ...body }, ...options })

// A pilot project's first pull with two creates failing: the execution ends `partial` (失败待恢复).
async function partialWorld() {
  const st = mount()
  const preview = dataOf(await st.dryRun())
  assert.equal(preview.status, 'ready', JSON.stringify(preview.status))
  st.sheet.failCreates = 2
  const applied = await st.apply(preview.dryRunToken)
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
  assert.equal(st.executions()[0].status, 'partial')
  return st
}

test('RR-01 tiers: list / recover PULL, close-unverified ADMIN (a puller 403); the floor 403 on all three; a tenantless platform admin refused by the operator scope; no records IO for any refusal', async () => {
  const st = await partialWorld()
  try {
    const executionId = st.executions()[0].id
    const queries = st.sheet.queries
    for (const [label, res] of [
      ['floor list', await list(st, { user: OPERATOR })],
      ['floor recover', await recover(st, executionId, { mode: 'verify' }, { user: OPERATOR })],
      ['floor close-unverified', await closeUnverified(st, executionId, { mode: 'inspect' }, { user: OPERATOR })],
      ['puller close-unverified', await closeUnverified(st, executionId, { mode: 'inspect' }, { user: PULLER })],
    ]) assert.equal(res.statusCode, 403, `${label}: ${JSON.stringify(res.body)}`)
    const tenantless = await recover(st, executionId, { mode: 'verify' }, { user: TENANTLESS_ADMIN })
    assert.equal(tenantless.statusCode, 403, JSON.stringify(tenantless.body))
    assert.equal(st.sheet.queries, queries, 'zero records IO for a refused caller')
    assert.equal(st.executions()[0].status, 'partial')
  } finally {
    st.h.restore()
  }
})

test('RR-02 the executions list: newest first, values-free (no principal), `recoverable`, no `batch` key while 批次标识 is off; audited before the answer', async () => {
  const st = await partialWorld()
  try {
    const before = st.audits().length
    const page = dataOf(await list(st))
    assert.equal(page.items.length, 1)
    const item = page.items[0]
    assert.deepEqual([item.status, item.recoverable, item.settlementSubject, item.binding.changePlanBound], ['partial', true, true, false])
    assert.equal(Object.prototype.hasOwnProperty.call(item, 'batch'), false, 'N-SWITCH: absent, not null')
    const text = JSON.stringify(page)
    for (const forbidden of ['u_rr_pull', 'startedBy', 'verifiedBy', 'leaseId', PROJECT]) assert.ok(!text.includes(forbidden), forbidden)
    const audits = st.audits().slice(before)
    assert.deepEqual(audits.map((row) => [row.action, row.mode]), [[REFRESH_DECISION_AUDIT.readAction, 'execution_list_read']])
    assert.equal(audits[0].detail.itemCount, 1)
    const bad = await list(st, { query: { limit: '50' } })
    expectRefusal(bad, { status: 400 })
  } finally {
    st.h.restore()
  }
})

test('RR-03 recover through the routes: 404 / NOT_UNFINISHED before any lease; verify (report + audited page, no bump); close under the recovery_verify lease, released, THEN bumped recovery_closed; the retry writes only the missing rows', async () => {
  const st = await partialWorld()
  try {
    const executionId = st.executions()[0].id
    const lockBefore = { ...st.lockRow() }
    expectRefusal(await recover(st, 'exec_absent', { mode: 'verify' }), { status: 404, code: CODES.EXECUTION_NOT_FOUND })
    assert.deepEqual([st.lockRow().fencing_epoch, st.lockRow().lease_id, st.lockRow().generation], [lockBefore.fencing_epoch, lockBefore.lease_id, lockBefore.generation], 'the prelude refused before the lease')
    const auditsBefore = st.audits().length
    const verified = dataOf(await recover(st, executionId, { mode: 'verify' }))
    assert.equal(verified.report.result, 'mixed')
    assert.equal(verified.report.counts.notLanded, 2)
    assert.equal(verified.pending.entries.length, 2)
    assert.deepEqual(st.audits().slice(auditsBefore).map((row) => [row.action, row.mode]), [[REFRESH_DECISION_AUDIT.readAction, 'execution_verify_read']])
    assert.equal(st.lockRow().generation, lockBefore.generation, 'a verify never bumps')
    assert.equal(st.lockRow().lease_id, null, 'released')
    const writes = st.sheet.writes
    const closed = dataOf(await recover(st, executionId, { mode: 'close', verifyDigest: verified.report.verifyDigest }))
    assert.deepEqual([closed.closed, closed.result, closed.preStatus, closed.generationBumped, closed.nextStep], [true, 'mixed', 'partial', true, 'preview_again'])
    assert.equal(st.sheet.writes, writes, 'the recovery wrote no record')
    const lock = st.lockRow()
    assert.deepEqual([lock.lease_id, lock.generation_reason, lock.generation], [null, 'recovery_closed', lockBefore.generation + 1])
    const closeAudit = st.audits().filter((row) => row.mode === 'execution_verified_closed')
    assert.equal(closeAudit.length, 1)
    assert.deepEqual([closeAudit[0].action, closeAudit[0].subjectId, closeAudit[0].actor], [REFRESH_DECISION_AUDIT.decisionAction, executionId, 'u_rr_pull'])
    assert.equal(st.executions()[0].verify_lease_run_id.startsWith('refresh-recover'), true, 'the recovery lease run id')
    expectRefusal(await recover(st, executionId, { mode: 'verify' }), { status: 409, code: CODES.EXECUTION_NOT_UNFINISHED, reason: 'verified_closed' })
    // The retry: a fresh preview, an apply that writes exactly the two missing rows.
    const preview = dataOf(await st.dryRun())
    assert.equal(preview.status, 'ready')
    dataOf(await st.apply(preview.dryRunToken))
    assert.equal(st.sheet.writes - writes, 2)
  } finally {
    st.h.restore()
  }
})

test('RR-04 the closed bodies and the typed project number refuse 400 before any IO (an unknown key, a wrong confirmProjectNo, a close without its digest, a cursor on a close)', async () => {
  const st = await partialWorld()
  try {
    const executionId = st.executions()[0].id
    const queries = st.sheet.queries
    for (const body of [
      { mode: 'verify', replay: true },
      { mode: 'verify', confirmProjectNo: 'PRJ-OTHER' },
      { mode: 'close' },
      { mode: 'close', verifyDigest: 'a'.repeat(64), pageCursor: 3 },
      { mode: 'replay' },
    ]) {
      const res = await recover(st, executionId, body)
      assert.equal(res.statusCode, 400, `${JSON.stringify(body)} => ${JSON.stringify(res.body)}`)
    }
    assert.equal(st.sheet.queries, queries)
  } finally {
    st.h.restore()
  }
})

test('RR-05 close-unverified (ADMIN): inspect reads the sheet only (no source read) and answers an inspectDigest; close with the echo, the acknowledgement and a ticket handle -> unknown / runbook, audited execution_closed_unverified, then bumped', async () => {
  const st = await partialWorld()
  try {
    const executionId = st.executions()[0].id
    const reads = st.source.reads
    const inspected = dataOf(await closeUnverified(st, executionId, { mode: 'inspect' }))
    assert.equal(st.source.reads, reads, 'no source read')
    assert.match(inspected.report.inspectDigest, /^[0-9a-f]{64}$/)
    expectRefusal(await closeUnverified(st, executionId, { mode: 'close', inspectDigest: inspected.report.inspectDigest, runbookRef: 'TICKET-RR-1' }), { status: 400 })
    const closed = dataOf(await closeUnverified(st, executionId, { mode: 'close', inspectDigest: inspected.report.inspectDigest, runbookRef: 'TICKET-RR-1', acknowledge: { resultUnknown: true } }))
    assert.deepEqual([closed.result, closed.closedMode, closed.settled, closed.generationBumped], ['unknown', 'runbook', false, true])
    assert.equal(st.source.reads, reads)
    const row = st.executions()[0]
    assert.deepEqual([row.status, row.verified_result, row.closed_mode, row.runbook_ref, row.verified_by], ['verified_closed', 'unknown', 'runbook', 'TICKET-RR-1', 'u_rr_admin'])
    assert.deepEqual(st.audits().filter((entry) => entry.mode === 'execution_closed_unverified').map((entry) => entry.action), [REFRESH_DECISION_AUDIT.decisionAction])
  } finally {
    st.h.restore()
  }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-execution-recovery-routes.test.cjs', tests)
