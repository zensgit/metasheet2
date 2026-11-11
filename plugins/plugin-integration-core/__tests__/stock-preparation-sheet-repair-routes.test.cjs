'use strict'

// 备料 batch-refresh step 6d-2a (S6-6; step-6 design §6.6, §10 「S6-6」; register row R-91) — THE DOUBLED-SHEET REPAIR ROUTES
// over the real route stack (support/stock-preparation-project-sheet-harness.cjs): the REAL repair library and ledger
// store, the REAL sheet write lock and the REAL batch ledger store on ONE faithful fake of migrations 108 + 100 + 105
// (support/stock-preparation-sheet-repair-kit.cjs), the REAL refresh governance, a records host that versions and
// enforces the write fence, and the canonical S / P source of the continuation fixtures. The sheet is design §6.1's D1:
// S-001 as its own root subtree AND as a copy nested under P-001, every row active.
//
//   RR-00  the three routes are registered, values-free, ADMIN manifest rows with `control: null`
//   RR-01  (RP-06) the gate order: 403 below ADMIN whatever the switches say; then 404 with ZERO IO while the repair
//          switch is not exactly 'true' or the project-sheets switch is off; a tenantless platform admin refused
//   RR-02  the closed body and the typed project number (400 / 409 before any IO); absent / archived / not the
//          registry's sheet (409); a missing service is 501 by name; a missing migration 108 and a missing audit
//          action (086 / 066) are 503 before any sheet or source read
//   RR-03  end to end: preview (listing, then the component) -> execute under the real `sheet_repair` lease (fenced,
//          version-conditional patches; the holder asserted in both ledger transactions) -> released -> bumped; the run
//          list; then the restore of that run puts every stored row back byte-identically; values-free answers
//   RR-04  (RP-01) a governed project: a preview refusal and 409 for an execute, nothing written — for a retire and
//          for the restore of a run whose project was governed afterwards
//   RR-05  the install gate through the route (coordinator ruling C-2): read from the batch ledger on every preview and
//          execute of a recipe WHATEVER the batch switch says — `installing` and a pending sheet that still carries an
//          aborted install's persisted plan (or its settings lock) are 409, with the switch off too; a pending sheet
//          with neither is repairable; its one read is the repair's only batch-ledger statement; an unwired or
//          unreadable ledger, or a row without its install facts, is 503 by name; the fills report and the run list
//          never read it
//   RR-06  mutual exclusion with a pull, a recovery and an install: whoever holds the sheet, the repair is 409
//          WRITE_LOCKED; while the repair holds it, a pull preview is 409 WRITE_LOCKED naming `sheet_repair`
//   RR-07  a host that cannot honour the write fence refuses the execute (501) BEFORE the claim is spent; the old root
//          still in the source refuses it too; a moved row stops it; an incomplete source read refuses it
//   RR-08  the fills report and the run list through their routes: values-free, audited before the answer
//   RR-09  the server-held deps the routes hand the library, exercised directly: the fenced patch refuses a missing
//          guard and a missing version before the host; after a takeover the pre-write holder CAS refuses the next
//          patch before it reaches the host; the holder assert the ledger runs is the lock's own
//   RR-10  the tenancy wall: a registry row that resolves onto ANOTHER tenant's sheet is refused 409 for all three
//          routes before any sheet, source or ledger read
//   RR-11  (ruling C-1) the heartbeat N6 rule through the route: every host patch of the route's fenced patch and both
//          ledger transactions run inside the guard's host-write bracket
//   RR-12  (ruling C-3) the continuation through the route: a run left `running` after every row was written is
//          verified and closed — no patch, audited, bumped, the batch ledger never read; refused with counts when a
//          row moved; works on a project that became governed
//   RR-13  (write-safety review of round 1) F-11 on both sides through the route, over the sheet's PHYSICAL field ids: a
//          row of the nested copy whose `active` cell is not the boolean true refuses the preview with its count and
//          the execute with 409 — no run, no claim, no patch; put right, the same approved digest runs
// Every value is synthetic.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const R = require(path.join(LIB, 'stock-preparation-sheet-repair.cjs'))
const { createStockPreparationSheetRepairStore } = require(path.join(LIB, 'stock-preparation-sheet-repair-store.cjs'))
const { createStockPreparationPullBatchStore } = require(path.join(LIB, 'stock-preparation-pull-batch-store.cjs'))
const lockLib = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const tableActions = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { EXISTING_ROW_RECORD_REF } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const { STOCK_PREP_WORKBENCH_CAPABILITIES, STOCK_PREP_ADMIN, STOCK_PREP_PULL, STOCK_PREP_READ, STOCK_PREP_OPERATE } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { __internals: { componentHandle } } = require(path.join(LIB, 'stock-preparation-sheet-census.cjs'))
const { __internals: auditInternals } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const harness = require('./support/stock-preparation-project-sheet-harness.cjs')
const kit = require('./support/stock-preparation-sheet-repair-kit.cjs')
const pbKit = require('./support/stock-preparation-pull-batch-kit.cjs')
const lockKit = require('./support/stock-preparation-project-write-lock-kit.cjs')
const F = require('./support/stock-preparation-continuation-fixtures.cjs')

const tests = []
const test = (name, fn) => tests.push([name, fn])

const CODES = R.SHEET_REPAIR_ERROR_CODES
const RETIRE = R.SHEET_REPAIR_RECIPES[0]
const RESTORE = R.SHEET_REPAIR_RECIPES[1]
const CLOSE = R.SHEET_REPAIR_CONTINUATIONS[0]
const TENANT = 'tenant-syn-rpr'
const PROJECT = F.PROJECT_NO
const HANDLE = componentHandle(TENANT, PROJECT, 'S-001')
const BASE = '/api/integration/stock-preparation/projects/:projectNo/target/sheet-repair'
const PATHS = Object.freeze({ repair: BASE, fills: `${BASE}/fills-report`, runs: `${BASE}/runs` })
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const REPAIR_ENV = R.STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED_ENV
const PULL_BATCH_ENV = 'STOCK_PREP_PULL_BATCH_ENABLED'
const ADMIN = Object.freeze({ id: 'u_rpr_admin', tenantId: TENANT, permissions: [STOCK_PREP_ADMIN] })
const PULLER = Object.freeze({ id: 'u_rpr_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const OPERATOR = Object.freeze({ id: 'u_rpr_operate', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const TENANTLESS = Object.freeze({ id: 'u_rpr_tl', roles: ['admin'], permissions: ['integration:admin'] })
const LEASE = Object.freeze({ async acquire() { return { leaseId: 'lease_rpr' } }, async release() { return true }, async renew() { return true } })

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

async function withEnv(values, fn) {
  const original = {}
  for (const [key, value] of Object.entries(values)) {
    original[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function untouchable(label) {
  return new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => { throw new Error(`${label} must not be touched: ${String(key)}`) }) })
}

/** A records host with the real host's filter semantics, version-conditional patches (+1) and a call log. */
function makeRecords() {
  const rows = []
  const calls = []
  const textOf = (value) => (typeof value === 'object' ? JSON.stringify(value) : String(value))
  const api = {
    rows,
    calls,
    beforePatch: null,
    async queryRecords(input = {}) {
      calls.push('queryRecords')
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
    },
    async patchRecord({ sheetId, recordId, changes, expectedVersion }) {
      calls.push('patchRecord')
      if (typeof api.onPatch === 'function') api.onPatch(recordId)
      if (typeof api.beforePatch === 'function') await api.beforePatch(recordId)
      const row = rows.find((entry) => entry.id === recordId && entry.sheetId === sheetId)
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'NOT_FOUND' })
      if (expectedVersion !== undefined && expectedVersion !== row.version) throw Object.assign(new Error('version conflict'), { code: 'VERSION_CONFLICT' })
      Object.assign(row.data, changes)
      row.version += 1
      return clone(row)
    },
    async createRecord() {
      calls.push('createRecord')
      throw new Error('this suite never creates a record')
    },
  }
  return api
}

/**
 * Mount the route stack over a D1 sheet. `repair` / `pullBatch` are the two env switches' values; `ledger: 'untouchable'`
 * hands the routes a batch ledger that throws on any call.
 */
async function mount({ switchOn = true, seed = switchOn, ledger = 'real', source = F.secondPullSource({ sLine: false }), serviceOverrides = {} } = {}) {
  const clock = kit.createClock()
  const db = kit.createFakeRepairDb({ clock, pullBatch: true })
  const repairStore = createStockPreparationSheetRepairStore({ db, now: clock.now })
  const lock = lockLib.createStockPreparationProjectWriteLock({ db })
  // The N6 witness (ruling C-1): the lock the ROUTES are handed is the real one with two things OBSERVED — the host-write
  // bracket of every lease it grants, and the in-transaction holder assert (the first statement of a ledger transaction).
  const bracket = { depth: 0, holderAsserts: [], patches: [] }
  const observedLock = Object.freeze({
    ...lock,
    withProjectWriteLease: (scopeKey, options, fn) => lock.withProjectWriteLease(scopeKey, options, (guard) => fn(Object.freeze({
      ...guard,
      withHostWrite: async (inner) => {
        bracket.depth += 1
        try {
          return await guard.withHostWrite(inner)
        } finally {
          bracket.depth -= 1
        }
      },
    }))),
    assertHolderWithin: (trx, scopeKey, options) => {
      bracket.holderAsserts.push([options && options.reason, bracket.depth])
      return lock.assertHolderWithin(trx, scopeKey, options)
    },
  })
  const pullBatchStore = ledger === 'real' ? createStockPreparationPullBatchStore({ db, now: clock.now }) : untouchable('the batch ledger')
  const sourceState = { data: source, reads: 0 }
  const adapter = {
    async read(input = {}) {
      sourceState.reads += 1
      const list = Array.isArray(sourceState.data[input.object]) ? sourceState.data[input.object] : []
      const matches = list.filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
      return { records: matches.map(clone), done: true, nextCursor: null }
    },
  }
  const h = harness.mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    switchOn,
    serviceExtras: {
      stockPreparationSheetRepairStore: repairStore,
      stockPreparationProjectWriteLock: observedLock,
      stockPreparationPullBatchStore: pullBatchStore,
      stockPreparationConfirmationDecisionLease: LEASE,
      adapterRegistry: { createAdapter() { return adapter }, listAdapterKinds() { return [] } },
      ...serviceOverrides,
    },
  })
  const records = makeRecords()
  records.onPatch = () => { bracket.patches.push(bracket.depth) }
  h.context.api.multitable.records = lockKit.withFakeHostWriteFence(records, { lockDb: db })
  const auditsWithin = []
  h.services.stockPreparationAuditStore.appendWithin = async (trx, entry) => {
    assert.equal(typeof trx.setLocalLockTimeout, 'function', 'appendWithin is handed the ledger transaction')
    auditInternals.assertValuesFreeDetail(entry.detail)
    auditsWithin.push(entry)
    return { ok: true }
  }
  const seeded = seed ? h.seedRegistryRow(PROJECT) : null
  const physical = seeded ? (fieldId) => h.provisioning.getFieldId(h.staging, seeded.objectId, fieldId) : null
  if (seeded) {
    // D1: the first pull's S-001 rows (a person's note on the root) AND the second pull's P-001 subtree with its nested
    // S-001 copies — every row active, each stored under the sheet's PHYSICAL field ids.
    const first = F.applyToSheet(F.plan(await F.expand(F.firstPullSource()), []), [], { idPrefix: 'rec_s', human: { 'S-001': { notes: 'synthetic note' } } })
    const second = F.applyToSheet(F.plan(await F.expand(F.secondPullSource({ sLine: false })), []), [], { idPrefix: 'rec_p' })
    for (const row of first.concat(second)) {
      const ref = row[EXISTING_ROW_RECORD_REF]
      const data = {}
      for (const [key, value] of Object.entries(row)) data[harness.TEMPLATE_FIELD_IDS.includes(key) ? physical(key) : key] = value
      records.rows.push({ id: ref.id, sheetId: seeded.sheetId, version: ref.version, createdBy: null, locked: false, data })
    }
    h.provisioning.calls.length = 0
  }
  const writeScope = seeded ? lockLib.sheetWriteScopeKey(seeded.sheetId) : null
  const st = {
    h, db, clock, lock, bracket, records, repairStore, auditsWithin, sourceState, seeded, physical, writeScope,
    // Every statement the request made on a batch-identifier table (the install gate's read is the only one allowed).
    batchStatements: () => db.log.filter(([, args]) => args && typeof args.table === 'string' && args.table.includes('pull_batch')).map(([method, args]) => [method, args.table]),
    patchCount: () => records.calls.filter((entry) => entry === 'patchRecord').length,
    /**
     * A retire whose LAST patch landed and whose finish was then refused (a pull took the sheet over on another
     * process's clock): every planned row is written and the run is left `running`. Returns the open run's id.
     */
    async leaveRetireOpen() {
      const plan = dataOf(await withEnv(ON, () => preview(st)))
      let patches = 0
      let taker = null
      records.beforePatch = async () => {
        patches += 1
        if (patches !== 4) return
        const other = lockLib.createStockPreparationProjectWriteLock({ db, now: () => new Date(Date.now() + LAPSED_MS) })
        taker = other.createGuard(await other.acquire(writeScope, { purpose: 'small_apply', runId: 'syn-pull-takeover', tenantId: TENANT }))
      }
      const lost = expectRefusal(await withEnv(ON, () => execute(st, plan.planDigest)), { status: 409, code: lockLib.PROJECT_WRITE_ERROR_CODES.LEASE_LOST })
      assert.deepEqual([lost.details.written, lost.details.planned], [4, 4])
      records.beforePatch = null
      await taker.release()
      return st.runs().find((run) => run.status === 'running').id
    },
    lockRow: () => db.rows(kit.T.lock).find((row) => row.scope_key === writeScope) || null,
    runs: () => db.rows(kit.T.run).sort((left, right) => left.sequence_no - right.sequence_no),
    claims: () => db.rows(kit.T.claim),
    oldRows: () => records.rows.filter((row) => row.id.startsWith('rec_s_')),
    copyRows: () => records.rows.filter((row) => row.id.startsWith('rec_p_')),
    cell: (row, fieldId) => row.data[physical(fieldId)],
    governed() {
      for (const row of h.registryRows()) {
        if (row.project_no !== PROJECT) continue
        row.pilot_enabled_at = new Date('2026-11-09T00:00:00Z')
        row.pilot_enabled_by = 'u_rpr_admin'
        row.pilot_readiness_version = 1
      }
    },
    /** Another writer holds the sheet's lease (a pull, a recovery, an install): returns its guard. */
    async holder(purpose) {
      return lock.createGuard(await lock.acquire(writeScope, { purpose, runId: `syn-${purpose}`, tenantId: TENANT }))
    },
    zeroIo(label) {
      assert.deepEqual([h.provisioning.calls, records.calls, h.tenantDirectoryCalls, db.log, auditsWithin, h.auditAppends], [[], [], [], [], [], []], `${label}: zero IO`)
    },
    clearLogs() {
      h.provisioning.calls.length = 0
      records.calls.length = 0
      h.tenantDirectoryCalls.length = 0
      db.log.length = 0
    },
  }
  return st
}

const call = (st, method, routePath, { user = ADMIN, body, query = {}, projectNo = PROJECT } = {}) =>
  harness.call(st.h.routes, method, routePath, { user, body, query, params: { projectNo } })
const repair = (st, body, options = {}) => call(st, 'POST', PATHS.repair, { body: { confirmProjectNo: PROJECT, ...body }, ...options })
const preview = (st, extra = {}, options = {}) => repair(st, { mode: 'preview', recipe: RETIRE, componentHandle: HANDLE, ...extra }, options)
const execute = (st, planDigest, extra = {}, options = {}) => repair(st, { mode: 'execute', recipe: RETIRE, componentHandle: HANDLE, planDigest, approvalRef: 'R-91:syn-window-1', ...extra }, options)
const ON = Object.freeze({ [REPAIR_ENV]: 'true', [PULL_BATCH_ENV]: undefined })
// Another process's clock, far enough ahead that it sees a live lease as lapsed and takes the sheet over.
const LAPSED_MS = lockLib.PROJECT_WRITE_LEASE_TTL_MS + lockLib.PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS + 60000

function dataOf(res) {
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  return res.body.data
}

function expectRefusal(res, { status, code, reason, field }) {
  assert.equal(res.statusCode, status, JSON.stringify(res.body))
  const error = res.body && res.body.error ? res.body.error : {}
  if (code !== undefined) assert.equal(error.code, code, JSON.stringify(error))
  if (reason !== undefined) assert.equal(error.details && error.details.reason, reason, JSON.stringify(error.details))
  if (field !== undefined) assert.equal(error.details && error.details.field, field, JSON.stringify(error.details))
  return error
}

function assertValuesFree(value, st, label) {
  const text = JSON.stringify(value)
  for (const planted of [PROJECT, TENANT, 'S-001', 'P-001', 'PART-A', 'D100-01', 'synthetic note', st.seeded.sheetId, st.seeded.objectId, 'fld_']) {
    assert.equal(text.includes(planted), false, `${label}: ${planted} leaked`)
  }
}

// ── RR-00 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RR-00 the three routes are registered, values-free, in the 4-space handler shape; their manifest rows are ADMIN with control: null', () => {
  const source = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8')
  for (const [method, routePath, handler] of [
    ['POST', PATHS.repair, 'stockPreparationProjectSheetRepair'],
    ['GET', PATHS.fills, 'stockPreparationProjectSheetRepairFillsReport'],
    ['GET', PATHS.runs, 'stockPreparationProjectSheetRepairRuns'],
  ]) {
    assert.ok(source.includes(`['${method}', '${routePath}', '${handler}'],`), `${handler} is in the route table`)
    assert.ok(source.includes(`    async ${handler}(req, res) {`), `${handler} is a handler`)
    assert.ok(httpRoutes.__internals.STOCK_PREPARATION_VALUES_FREE_HANDLERS.has(handler), `${handler} answers values-free`)
  }
  const rows = STOCK_PREP_WORKBENCH_CAPABILITIES.filter((entry) => entry.path.includes('/target/sheet-repair'))
  assert.deepEqual(rows.map((entry) => [entry.capability, entry.code, entry.method, entry.path, entry.control]), [
    ['projectTarget.sheetRepair', STOCK_PREP_ADMIN, 'POST', PATHS.repair, null],
    ['projectTarget.sheetRepairFillsReport', STOCK_PREP_ADMIN, 'GET', PATHS.fills, null],
    ['projectTarget.sheetRepairRuns', STOCK_PREP_ADMIN, 'GET', PATHS.runs, null],
  ])
})

// ── RR-01 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RR-01 (RP-06) the gate order: 403 below ADMIN whatever the switches say; then 404 with ZERO IO while the repair switch is not exactly \'true\' or the project-sheets switch is off; a tenantless platform admin is refused', async () => {
  const requests = (st, user) => [
    ['preview', () => preview(st, {}, { user })],
    ['execute', () => execute(st, 'a'.repeat(64), {}, { user })],
    ['fills', () => call(st, 'GET', PATHS.fills, { user })],
    ['runs', () => call(st, 'GET', PATHS.runs, { user })],
  ]
  const st = await mount()
  try {
    // The gate comes FIRST: below ADMIN is 403 with the switch on AND off (the switch state is not disclosed).
    for (const env of [ON, { [REPAIR_ENV]: undefined }]) {
      for (const user of [PULLER, OPERATOR]) {
        for (const [label, send] of requests(st, user)) {
          st.clearLogs()
          const res = await withEnv(env, send)
          assert.equal(res.statusCode, 403, `${label} as ${user.id} (${env[REPAIR_ENV]}): ${JSON.stringify(res.body)}`)
          st.zeroIo(`${label} as ${user.id}`)
        }
      }
    }
    // ADMIN, the repair switch not exactly 'true': 404 before any IO — preview, fills report and run list included.
    for (const value of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes']) {
      for (const [label, send] of requests(st, ADMIN)) {
        st.clearLogs()
        const res = await withEnv({ [REPAIR_ENV]: value }, send)
        expectRefusal(res, { status: 404, code: CODES.DISABLED })
        st.zeroIo(`${label} with the switch ${JSON.stringify(value)}`)
      }
    }
    // A malformed body with the switch OFF is still the 404 (the switch precedes the body).
    st.clearLogs()
    expectRefusal(await withEnv({ [REPAIR_ENV]: undefined }, () => repair(st, { mode: 'nonsense' })), { status: 404, code: CODES.DISABLED })
    assert.equal(st.sourceState.reads, 0, 'the source was never read')
    assert.deepEqual([st.runs(), st.claims(), st.lockRow()], [[], [], null])
    // A tenantless platform admin: refused by the host-vouched operator scope, before any records IO.
    st.clearLogs()
    const tenantless = await withEnv(ON, () => preview(st, {}, { user: TENANTLESS }))
    assert.ok([400, 403].includes(tenantless.statusCode), JSON.stringify(tenantless.body))
    assert.deepEqual([st.records.calls, st.db.log], [[], []])
  } finally { st.h.restore() }
  // The project-sheets switch off: its own 404, zero IO, whatever the repair switch says.
  const off = await mount({ switchOn: false })
  try {
    for (const [label, send] of [['preview', () => preview(off)], ['fills', () => call(off, 'GET', PATHS.fills)], ['runs', () => call(off, 'GET', PATHS.runs)]]) {
      off.clearLogs()
      expectRefusal(await withEnv(ON, send), { status: 404, code: 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED' })
      off.zeroIo(`${label} with project sheets off`)
    }
  } finally { off.h.restore() }
})

// ── RR-02 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RR-02 the closed body and the typed project number (before any IO); absent / archived / not the registry\'s sheet; a missing service is 501 by name', async () => {
  const st = await mount()
  try {
    for (const [body, field] of [
      [{ mode: 'preview', recipe: RETIRE, tenantId: TENANT }, 'tenantId'],
      [{ mode: 'preview', recipe: RETIRE, sheetId: 'sheet_x' }, 'sheetId'],
      [{ mode: 'preview', recipe: 'delete_rows' }, 'recipe'],
      [{ mode: 'apply', recipe: RETIRE }, 'mode'],
      [{ mode: 'execute', recipe: RETIRE, componentHandle: HANDLE, planDigest: 'a'.repeat(64) }, 'approvalRef'],
      [{ mode: 'execute', recipe: RETIRE, componentHandle: HANDLE, approvalRef: 'R-91' }, 'planDigest'],
      [{ mode: 'preview', recipe: RESTORE }, 'runId'],
      [{ mode: 'preview', recipe: CLOSE }, 'runId'],
      [{ mode: 'preview', recipe: CLOSE, runId: `${R.SHEET_REPAIR_RUN_ID_PREFIX}00000000-0000-4000-8000-000000000000`, componentHandle: HANDLE }, 'componentHandle'],
      [{ mode: 'execute', recipe: CLOSE, runId: `${R.SHEET_REPAIR_RUN_ID_PREFIX}00000000-0000-4000-8000-000000000000`, planDigest: 'a'.repeat(64) }, 'approvalRef'],
    ]) {
      st.clearLogs()
      expectRefusal(await withEnv(ON, () => repair(st, body)), { status: 400, code: CODES.REQUEST_INVALID, field })
      st.zeroIo(`body ${field}`)
    }
    st.clearLogs()
    expectRefusal(await withEnv(ON, () => repair(st, { mode: 'preview', recipe: RETIRE, confirmProjectNo: 'SYN-OTHER' })), { status: 409, code: CODES.CONFIRM_MISMATCH, field: 'confirmProjectNo' })
    st.zeroIo('confirm mismatch')
    for (const query of [{ tenantId: TENANT }, { componentHandle: 'x' }, { cursor: '3' }]) {
      st.clearLogs()
      expectRefusal(await withEnv(ON, () => call(st, 'GET', PATHS.fills, { query })), { status: 400, code: CODES.REQUEST_INVALID })
      st.zeroIo('fills query')
    }
    expectRefusal(await withEnv(ON, () => call(st, 'GET', PATHS.runs, { query: { limit: '5' } })), { status: 400, code: CODES.REQUEST_INVALID, field: 'limit' })
    // A project with no registered sheet (the registry answers before any sheet read).
    st.clearLogs()
    expectRefusal(await withEnv(ON, () => repair(st, { mode: 'preview', recipe: RETIRE, confirmProjectNo: 'SYN-ABSENT' }, { projectNo: 'SYN-ABSENT' })), { status: 409, code: 'STOCK_PREPARATION_PROJECT_ABSENT' })
    assert.deepEqual([st.records.calls, st.sourceState.reads], [[], 0])
    // The registry row names another object than the resolved target: refused.
    st.h.registryRows()[0].object_id = 'plm_stock_preparation_project_overview'
    assert.equal((await withEnv(ON, () => preview(st))).statusCode, 409)
    assert.deepEqual(st.records.calls, [], 'no sheet read on a refused object')
  } finally { st.h.restore() }
  const archived = await mount()
  try {
    const row = archived.h.registryRows()[0]
    Object.assign(row, { status: 'archived', archived_at: new Date('2026-11-09T00:00:00Z'), archived_by: 'seed' })
    expectRefusal(await withEnv(ON, () => preview(archived)), { status: 409, code: 'STOCK_PREPARATION_PROJECT_ARCHIVED' })
    assert.deepEqual(archived.records.calls, [])
  } finally { archived.h.restore() }
  // Services: each missing one is a 501 by name, before the scope lookup and any IO.
  const noStore = await mount({ serviceOverrides: { stockPreparationSheetRepairStore: null } })
  try {
    noStore.clearLogs()
    expectRefusal(await withEnv(ON, () => preview(noStore)), { status: 501, code: CODES.UNAVAILABLE, field: 'store' })
    assert.deepEqual([noStore.records.calls, noStore.h.tenantDirectoryCalls], [[], []])
  } finally { noStore.h.restore() }
  const noAudit = await mount()
  try {
    noAudit.h.services.stockPreparationAuditStore.appendWithin = undefined
    expectRefusal(await withEnv(ON, () => preview(noAudit)), { status: 501, code: 'AUDIT_STORE_UNAVAILABLE' })
  } finally { noAudit.h.restore() }
  const noHolder = await mount()
  try {
    // A lock module without the in-transaction holder assert: nothing is repaired without it.
    const real = noHolder.h.services.stockPreparationProjectWriteLock
    const partial = { ...real, assertHolderWithin: undefined }
    const again = await mount({ serviceOverrides: { stockPreparationProjectWriteLock: partial } })
    try {
      expectRefusal(await withEnv(ON, () => preview(again)), { status: 501, code: lockLib.PROJECT_WRITE_ERROR_CODES.UNAVAILABLE, reason: 'holder_within' })
    } finally { again.h.restore() }
  } finally { noHolder.h.restore() }
  // Migration 108 missing: the probe answers 503 before the sheet or the source is read.
  const no108 = await mount()
  try {
    no108.db.faults.select = (args) => (args.table === kit.T.claim ? kit.sqlError('42P01', 'relation does not exist') : null)
    const error = expectRefusal(await withEnv(ON, () => preview(no108)), { status: 503, code: CODES.STORE_FAILED })
    assert.deepEqual([error.details.operation, error.details.sqlState, no108.records.calls, no108.sourceState.reads], ['probe', '42P01', [], 0])
  } finally { no108.h.restore() }
  // The audit vocabulary: a database that does not accept one of the two audit actions yet (086 / 066 not applied)
  // refuses before the sheet, the source or the repair ledger is read — nothing is repaired or reported unaudited.
  for (const [missing, migration] of [['project_board_read', '086'], ['exception_resolve', '066']]) {
    const noVocabulary = await mount()
    try {
      noVocabulary.h.services.stockPreparationAuditStore.supportsAction = async (action) => ({ supported: action !== missing })
      noVocabulary.clearLogs()
      const error = expectRefusal(await withEnv(ON, () => preview(noVocabulary)), { status: 503, code: 'STOCK_PREPARATION_AUDIT_VOCABULARY_UNAVAILABLE' })
      assert.deepEqual([error.details.migration, noVocabulary.records.calls, noVocabulary.sourceState.reads, noVocabulary.db.log], [migration, [], 0, []], missing)
    } finally { noVocabulary.h.restore() }
  }
})

// ── RR-03 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RR-03 end to end through the routes: preview -> execute under the real sheet_repair lease (fenced, version-conditional) -> released -> bumped; the run list; the restore puts every stored row back byte-identically', async () => {
  const st = await mount()
  try {
    const before = clone(st.records.rows)
    // The listing, then the component's plan.
    const listing = dataOf(await withEnv(ON, () => repair(st, { mode: 'preview', recipe: RETIRE })))
    assert.deepEqual([listing.total, listing.components.length, listing.components[0].componentHandle, listing.components[0].eligible, listing.components[0].shape], [1, 1, HANDLE, true, 'two_copy'])
    const plan = dataOf(await withEnv(ON, () => preview(st)))
    assert.deepEqual([plan.mode, plan.recipe, plan.eligible, plan.refusals, plan.sequence, plan.openRun], ['preview', RETIRE, true, [], 0, false])
    assert.deepEqual([plan.counts.oldRows, plan.counts.toRetire, plan.counts.pairs, plan.counts.pairedCopies], [4, 4, 4, 1])
    assert.match(plan.planDigest, /^[0-9a-f]{64}$/)
    assert.deepEqual([st.runs(), st.claims(), st.records.calls.includes('patchRecord'), st.lockRow()], [[], [], false, null], 'a preview writes nothing and takes no lease')
    assert.deepEqual(st.h.auditAppends.map((entry) => [entry.action, entry.mode, entry.projectId === undefined || entry.projectId === null]), [['project_board_read', 'sheet_repair_preview_read', true], ['project_board_read', 'sheet_repair_preview_read', true]])
    // The execute: the lease is the repair's while the patches run.
    const during = []
    st.records.beforePatch = () => { during.push([st.lockRow().lease_purpose, st.runs()[0].status, st.claims().length]) }
    const done = dataOf(await withEnv(ON, () => execute(st, plan.planDigest)))
    assert.deepEqual([done.mode, done.recipe, done.status, done.planned, done.written, done.generationBumped, done.componentHandle, done.planDigest], ['execute', RETIRE, 'completed', 4, 4, true, HANDLE, plan.planDigest])
    assert.deepEqual(during, Array(4).fill(['sheet_repair', 'running', 1]), 'every patch ran under the sheet_repair lease, after the run row and its claim')
    assert.equal(st.h.context.api.multitable.records.fakeHostFences.length, 4, 'every patch carried the host write fence')
    const lockRow = st.lockRow()
    assert.deepEqual([lockRow.lease_id, lockRow.generation_reason, lockRow.generation], [null, 'sheet_repair', 1], 'released, then bumped with the repair reason')
    for (const row of st.oldRows()) {
      assert.strictEqual(st.cell(row, 'active'), false, 'F-11: the boolean false, under the PHYSICAL id')
      assert.deepEqual([st.cell(row, 'lastPlmRefreshRunId'), st.cell(row, 'lastPlmRefreshDecision'), st.cell(row, 'lastPlmConflictSummary')], [done.runId, 'inactive', '{"type":"sheet_repair_retire"}'])
      assert.equal(row.version, 2)
      assert.equal(Object.prototype.hasOwnProperty.call(row.data, 'active'), false, 'no logical id was sent raw')
    }
    assert.deepEqual(st.copyRows().map((row) => [row.version, st.cell(row, 'active')]), Array(st.copyRows().length).fill([1, true]), 'the copies and the parent are untouched')
    assert.deepEqual(st.auditsWithin.map((entry) => [entry.action, entry.mode, entry.subjectId, entry.projectId, entry.actor, entry.detail.tenantClaimVerified === undefined]), [
      ['exception_resolve', 'sheet_repair_started', done.runId, PROJECT, ADMIN.id, false],
      ['exception_resolve', 'sheet_repair_completed', done.runId, PROJECT, ADMIN.id, false],
    ])
    assert.equal(JSON.stringify(st.auditsWithin.map((entry) => entry.detail)).includes(PROJECT), false, 'the project number is never in a detail')
    const run = st.runs()[0]
    assert.deepEqual([run.status, run.written_count, run.approval_ref, run.started_by, run.tenant_id, run.project_no, run.sheet_id, run.write_scope_key], ['completed', 4, 'R-91:syn-window-1', ADMIN.id, TENANT, PROJECT, st.seeded.sheetId, st.writeScope])
    // The approved digest is spent.
    expectRefusal(await withEnv(ON, () => execute(st, plan.planDigest)), { status: 409, code: CODES.ALREADY_CONSUMED })
    // The census now reads the component as an inactive root remnant; a second retire has nothing of that shape.
    const after = dataOf(await withEnv(ON, () => preview(st)))
    assert.deepEqual([after.eligible, after.shape, after.refusals], [false, 'inactive_root_remnant', ['not_two_copy']])
    // The run list.
    const listed = dataOf(await withEnv(ON, () => call(st, 'GET', PATHS.runs)))
    assert.deepEqual(listed.runs.map((entry) => [entry.runId, entry.recipe, entry.status, entry.planned, entry.written, entry.componentHandle, entry.approvalRef]), [[done.runId, RETIRE, 'completed', 4, 4, HANDLE, 'R-91:syn-window-1']])
    for (const [label, answer] of [['listing', listing], ['preview', plan], ['execute', done], ['runs', listed]]) assertValuesFree(answer, st, label)
    // The restore of that run: its own preview digest, its own approval, its own claim — and byte-identity.
    const restorePlan = dataOf(await withEnv(ON, () => repair(st, { mode: 'preview', recipe: RESTORE, runId: done.runId })))
    assert.deepEqual([restorePlan.eligible, restorePlan.sequence, restorePlan.counts.toRestore, restorePlan.counts.versionMovedStampIntact], [true, 1, 4, 0])
    const restored = dataOf(await withEnv(ON, () => repair(st, { mode: 'execute', recipe: RESTORE, runId: done.runId, planDigest: restorePlan.planDigest, approvalRef: 'R-91:syn-window-2' })))
    assert.deepEqual([restored.status, restored.written, restored.sourceRunId, restored.generationBumped], ['completed', 4, done.runId, true])
    for (const row of st.records.rows) {
      const original = before.find((entry) => entry.id === row.id)
      assert.equal(JSON.stringify(row.data), JSON.stringify(original.data), `${row.id}: the stored data is byte-identical to before the retire`)
      assert.equal(row.version, original.version + (row.id.startsWith('rec_s_') ? 2 : 0))
    }
    assert.deepEqual(st.runs().map((entry) => [entry.recipe, entry.status, entry.sequence_no]), [[RETIRE, 'completed', 0], [RESTORE, 'completed', 1]])
    assert.equal(st.claims().length, 2)
    assertValuesFree(restorePlan, st, 'restore preview')
    assertValuesFree(restored, st, 'restore execute')
  } finally { st.h.restore() }
})

// ── RR-04 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RR-04 (RP-01) a governed project is never repaired: the preview names project_governed, an execute is 409, nothing is written', async () => {
  const st = await mount()
  try {
    const plan = dataOf(await withEnv(ON, () => preview(st)))
    assert.equal(plan.eligible, true)
    // The pilot is enabled between the preview and the execute: the in-lease recompute sees it.
    st.governed()
    const refused = dataOf(await withEnv(ON, () => preview(st)))
    assert.deepEqual([refused.eligible, refused.refusals.includes('project_governed'), refused.planDigest], [false, true, null])
    const error = expectRefusal(await withEnv(ON, () => execute(st, plan.planDigest)), { status: 409, code: CODES.NOT_APPLICABLE })
    assert.ok(error.details.reasons.includes('project_governed'), JSON.stringify(error.details))
    assert.deepEqual([st.records.calls.includes('patchRecord'), st.runs(), st.claims(), st.lockRow().lease_id], [false, [], [], null])
    for (const row of st.oldRows()) assert.strictEqual(st.cell(row, 'active'), true)
  } finally { st.h.restore() }
  // A restore is refused the same way: the pilot was enabled after the retire, so nothing is put back.
  const later = await mount()
  try {
    const plan = dataOf(await withEnv(ON, () => preview(later)))
    const done = dataOf(await withEnv(ON, () => execute(later, plan.planDigest)))
    const restorePlan = dataOf(await withEnv(ON, () => repair(later, { mode: 'preview', recipe: RESTORE, runId: done.runId })))
    assert.equal(restorePlan.eligible, true)
    later.governed()
    const refused = dataOf(await withEnv(ON, () => repair(later, { mode: 'preview', recipe: RESTORE, runId: done.runId })))
    assert.deepEqual([refused.eligible, refused.refusals, refused.planDigest], [false, ['project_governed'], null])
    const patchesBefore = later.records.calls.filter((entry) => entry === 'patchRecord').length
    const error = expectRefusal(await withEnv(ON, () => repair(later, { mode: 'execute', recipe: RESTORE, runId: done.runId, planDigest: restorePlan.planDigest, approvalRef: 'R-91:syn-window-2' })), { status: 409, code: CODES.NOT_APPLICABLE })
    assert.deepEqual(error.details.reasons, ['project_governed'])
    assert.deepEqual([later.records.calls.filter((entry) => entry === 'patchRecord').length, later.runs().length, later.claims().length], [patchesBefore, 1, 1])
    for (const row of later.oldRows()) assert.strictEqual(later.cell(row, 'active'), false, 'the retired rows stay retired')
  } finally { later.h.restore() }
})

// ── RR-05 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RR-05 the install gate through the route (rebaseline B-9; ruling C-2): read from the batch ledger on every preview and execute WHATEVER the batch switch says; `installing` and a pending sheet that still carries an aborted install\'s persisted plan (or its settings lock) are 409; an unwired or unreadable ledger is 503 by name; the fills report and the run list never read it', async () => {
  const BOTH = { [REPAIR_ENV]: 'true', [PULL_BATCH_ENV]: 'true' }
  const GATE_READ = [['selectOne', pbKit.T.sheet], ['select', pbKit.T.batch]]
  // The SAME behaviour with the batch switch off (`ON` leaves it unset) and on: the gate does not look at the switch.
  for (const [label, env] of [['the batch switch OFF', ON], ['the batch switch on', BOTH]]) {
    const st = await mount()
    try {
      // No ledger row (the batch identifier never touched this sheet): repairable.
      st.clearLogs()
      assert.equal(dataOf(await withEnv(env, () => preview(st))).eligible, true, label)
      if (env === ON) assert.deepEqual(st.batchStatements(), GATE_READ, 'off: the gate\'s one read of the sheet state is the request\'s ONLY batch-ledger statement')
      const sheetRow = pbKit.sheetRow({ tenantId: TENANT, sheetId: st.seeded.sheetId, projectNo: PROJECT, status: 'born_empty' })
      st.db.seed(pbKit.T.sheet, sheetRow)
      const plan = dataOf(await withEnv(env, () => preview(st)))
      assert.equal(plan.eligible, true, `${label}: a resolved sheet is repairable`)
      // An install begins after the preview: the execute's in-lease read refuses it; so does a new preview.
      await st.db.updateRow(pbKit.T.sheet, { history_status: 'installing', settings_locked_at: '2026-11-10T00:00:00.000Z' }, { id: sheetRow.id })
      st.clearLogs()
      const error = expectRefusal(await withEnv(env, () => execute(st, plan.planDigest)), { status: 409, code: CODES.INSTALL_IN_PROGRESS, reason: 'install_in_progress' })
      assert.equal(error.details.partial, false)
      assert.deepEqual([st.records.calls.includes('patchRecord'), st.runs(), st.claims(), st.lockRow().lease_id], [false, [], [], null], label)
      if (env === ON) assert.deepEqual(st.batchStatements(), GATE_READ, 'off: the execute read the sheet state once, inside the lease, and nothing else of that ledger')
      const refused = dataOf(await withEnv(env, () => preview(st)))
      assert.deepEqual([refused.eligible, refused.refusals, refused.planDigest], [false, ['install_in_progress'], null], label)
      // That install is ABORTED: the row is `pending` again and still carries its persisted plan (here with its settings
      // lock held as well — a label of the plan was on the sheet). Its next run RESUMES that plan whenever one of its
      // labels is on the sheet: refused under the same code, naming the state.
      await st.db.updateRow(pbKit.T.sheet, { history_status: 'pending', history_plan: { aborted: true }, resolved_at: null, resolved_by: null, history_mode: null, history_batch_count: null }, { id: sheetRow.id })
      const held = dataOf(await withEnv(env, () => preview(st)))
      assert.deepEqual([held.eligible, held.refusals, held.planDigest], [false, ['install_aborted_unresolved'], null], label)
      const heldError = expectRefusal(await withEnv(env, () => execute(st, plan.planDigest)), { status: 409, code: CODES.INSTALL_IN_PROGRESS, reason: 'install_aborted_unresolved' })
      assert.equal(heldError.details.partial, false)
      assert.deepEqual([st.records.calls.includes('patchRecord'), st.runs(), st.claims()], [false, [], []], label)
      // The batch ledger untouched by the repair: the row is exactly what the install left.
      assert.deepEqual(st.db.rows(pbKit.T.sheet).map((row) => [row.history_status, row.version, row.settings_locked_at]), [['pending', 0, '2026-11-10T00:00:00.000Z']])
      // The abort RELEASED the lock (no label of the plan was on the sheet THEN) and the plan is still on the row:
      // refused all the same (ruling C-2 — the ledger shows the plan; it cannot show whether a labelled row has come
      // back to the sheet since, and the install's next run would then resume that plan).
      await st.db.updateRow(pbKit.T.sheet, { settings_locked_at: null }, { id: sheetRow.id })
      const kept = dataOf(await withEnv(env, () => preview(st)))
      assert.deepEqual([kept.eligible, kept.refusals, kept.planDigest], [false, ['install_aborted_unresolved'], null], `${label}: the plan alone`)
      const keptError = expectRefusal(await withEnv(env, () => execute(st, plan.planDigest)), { status: 409, code: CODES.INSTALL_IN_PROGRESS, reason: 'install_aborted_unresolved' })
      assert.equal(keptError.details.partial, false)
      // The plan's DIGEST alone (a plan cell that no longer reads) is a persisted plan too …
      await st.db.updateRow(pbKit.T.sheet, { history_plan: null, history_plan_digest: 'd'.repeat(64) }, { id: sheetRow.id })
      assert.deepEqual(dataOf(await withEnv(env, () => preview(st))).refusals, ['install_aborted_unresolved'], `${label}: the digest alone`)
      // … and so is the settings lock alone (a plan the abort could not read keeps it).
      await st.db.updateRow(pbKit.T.sheet, { history_plan_digest: null, settings_locked_at: '2026-11-10T00:00:00.000Z' }, { id: sheetRow.id })
      assert.deepEqual(dataOf(await withEnv(env, () => preview(st))).refusals, ['install_aborted_unresolved'], `${label}: the lock alone`)
      expectRefusal(await withEnv(env, () => execute(st, plan.planDigest)), { status: 409, code: CODES.INSTALL_IN_PROGRESS, reason: 'install_aborted_unresolved' })
      assert.deepEqual([st.records.calls.includes('patchRecord'), st.runs(), st.claims(), st.lockRow().lease_id], [false, [], [], null], label)
      // A pending sheet with NEITHER a plan nor a lock (never installed: its first install plans from the rows as they
      // are then) is repairable — the SAME approved digest runs.
      await st.db.updateRow(pbKit.T.sheet, { settings_locked_at: null }, { id: sheetRow.id })
      assert.deepEqual(st.db.rows(pbKit.T.sheet).map((row) => [row.history_status, row.history_plan, row.history_plan_digest, row.settings_locked_at]), [['pending', null, null, null]])
      assert.equal(dataOf(await withEnv(env, () => execute(st, plan.planDigest))).status, 'completed', label)
    } finally { st.h.restore() }
  }
  // A ledger that cannot be READ (every call throws), switch off: the gate cannot be answered, so a preview and an
  // execute are refused by name and nothing begins — while the two reads never touch that ledger and still answer.
  const unreadable = await mount({ ledger: 'untouchable' })
  try {
    for (const send of [() => preview(unreadable), () => execute(unreadable, 'a'.repeat(64))]) {
      const error = expectRefusal(await withEnv(ON, send), { status: 503, code: 'STOCK_PREP_PULL_BATCH_STORE_FAILED' })
      assert.deepEqual([error.details.operation, error.details.partial, unreadable.records.calls.includes('patchRecord'), unreadable.sourceState.reads, unreadable.runs(), unreadable.claims()], ['read_sheet', false, false, 0, [], []])
    }
    assert.equal(unreadable.lockRow().lease_id, null, 'the execute\'s lease was released')
    assert.equal(dataOf(await withEnv(ON, () => call(unreadable, 'GET', PATHS.fills))).total, 1)
    assert.deepEqual(dataOf(await withEnv(ON, () => call(unreadable, 'GET', PATHS.runs))), { runs: [], truncated: false })
  } finally { unreadable.h.restore() }
  // The ledger NOT WIRED, switch off and on: refused by name before the sheet, the source, the lock or the repair
  // ledger's runs are touched (never "not installing").
  const unwired = await mount({ serviceOverrides: { stockPreparationPullBatchStore: null } })
  try {
    for (const env of [ON, BOTH]) {
      for (const send of [() => preview(unwired), () => execute(unwired, 'a'.repeat(64))]) {
        unwired.clearLogs()
        const error = expectRefusal(await withEnv(env, send), { status: 503, code: 'STOCK_PREP_PULL_BATCH_STORE_FAILED' })
        assert.deepEqual([error.details.operation, error.details.partial, unwired.records.calls, unwired.sourceState.reads, unwired.runs(), unwired.claims(), unwired.lockRow()], ['store_unwired', false, [], 0, [], [], null])
      }
    }
    // The reads do not need it.
    assert.equal(dataOf(await withEnv(ON, () => call(unwired, 'GET', PATHS.fills))).total, 1)
    assert.deepEqual(dataOf(await withEnv(ON, () => call(unwired, 'GET', PATHS.runs))), { runs: [], truncated: false })
  } finally { unwired.h.restore() }
  // A ledger that answers something that is not its sheet state is 503 too — never "no row".
  const odd = await mount({ serviceOverrides: { stockPreparationPullBatchStore: { readSheetState: async () => ({ batches: [] }) } } })
  try {
    const error = expectRefusal(await withEnv(ON, () => preview(odd)), { status: 503, code: 'STOCK_PREP_PULL_BATCH_STORE_FAILED' })
    assert.equal(error.details.operation, 'read_sheet_shape')
  } finally { odd.h.restore() }
  // A sheet row WITHOUT one of its install facts (the status, the plan, the plan's digest, the settings lock) is not
  // the ledger's shape either: 503 naming the facts — never "no plan" or "not locked". Each fact in turn, on a row
  // that would otherwise read as repairable; the whole row is the control.
  const whole = { historyStatus: 'pending', historyPlan: null, historyPlanDigest: null, settingsLockedAt: null }
  for (const missing of [null, 'historyStatus', 'historyPlan', 'historyPlanDigest', 'settingsLockedAt']) {
    const sheet = { ...whole }
    if (missing) delete sheet[missing]
    const partial = await mount({ serviceOverrides: { stockPreparationPullBatchStore: { readSheetState: async () => ({ sheet, batches: [] }) } } })
    try {
      const answer = await withEnv(ON, () => preview(partial))
      if (!missing) {
        assert.equal(dataOf(answer).eligible, true, 'the control: the whole row of a never-installed pending sheet is repairable')
        continue
      }
      const error = expectRefusal(answer, { status: 503, code: 'STOCK_PREP_PULL_BATCH_STORE_FAILED' })
      assert.deepEqual([error.details.operation, error.details.partial, partial.sourceState.reads, partial.runs(), partial.claims()], ['read_sheet_facts', false, 0, [], []], missing)
    } finally { partial.h.restore() }
  }
})

// ── RR-06 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RR-06 mutual exclusion on the sheet lease: a pull, a recovery or an install holding the sheet refuses the repair 409 WRITE_LOCKED; while the repair holds it, a pull preview is refused naming sheet_repair', async () => {
  for (const purpose of ['small_apply', 'large_apply_chunk', 'recovery_verify', 'pull_batch_install', 'pilot_enable', 'carry_confirm']) {
    const st = await mount()
    try {
      const plan = dataOf(await withEnv(ON, () => preview(st)))
      const holder = await st.holder(purpose)
      const blockedPreview = expectRefusal(await withEnv(ON, () => preview(st)), { status: 409, code: lockLib.PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED })
      assert.equal(blockedPreview.details.holderPurpose, purpose)
      const blocked = expectRefusal(await withEnv(ON, () => execute(st, plan.planDigest)), { status: 409, code: lockLib.PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED })
      assert.equal(blocked.details.holderPurpose, purpose)
      assert.deepEqual([st.records.calls.includes('patchRecord'), st.runs(), st.claims()], [false, [], []], `${purpose}: nothing of the repair ran`)
      assert.equal(st.lockRow().lease_purpose, purpose, 'the holder keeps the sheet')
      await holder.release()
      // Once the holder is gone the SAME approved digest still runs (a busy refusal spends nothing).
      assert.equal(dataOf(await withEnv(ON, () => execute(st, plan.planDigest))).status, 'completed')
    } finally { st.h.restore() }
  }
  // The other direction: the repair holds the sheet; a puller's preview is refused before any source read.
  const st = await mount()
  try {
    const plan = dataOf(await withEnv(ON, () => preview(st)))
    const seen = []
    st.records.beforePatch = async () => {
      if (seen.length > 0) return
      const reads = st.sourceState.reads
      const res = await harness.call(st.h.routes, 'POST', DRY_RUN_PATH, { user: PULLER, params: { actionId: tableActions.PLM_STOCK_PREPARATION_ACTION_ID }, body: { parameters: { projectNo: PROJECT } }, query: { tenantId: TENANT } })
      seen.push([res.statusCode, res.body && res.body.error && res.body.error.code, res.body && res.body.error && res.body.error.details && res.body.error.details.holderPurpose, st.sourceState.reads - reads])
    }
    assert.equal(dataOf(await withEnv(ON, () => execute(st, plan.planDigest))).status, 'completed')
    assert.deepEqual(seen, [[409, lockLib.PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 'sheet_repair', 0]])
  } finally { st.h.restore() }
})

// ── RR-07 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RR-07 a host that cannot honour the write fence refuses the execute (501) BEFORE the claim is spent; an old root still in the source refuses it; a moved row stops it', async () => {
  const st = await mount()
  try {
    const plan = dataOf(await withEnv(ON, () => preview(st)))
    // The records host stops declaring the write fence.
    st.h.context.api.multitable.records = st.records
    const error = expectRefusal(await withEnv(ON, () => execute(st, plan.planDigest)), { status: 501, code: lockLib.PROJECT_WRITE_ERROR_CODES.UNAVAILABLE, reason: 'host_fence_unsupported' })
    assert.equal(error.details.reason, 'host_fence_unsupported')
    assert.deepEqual([st.records.calls.includes('patchRecord'), st.runs(), st.claims(), st.lockRow().lease_id], [false, [], [], null], 'no claim was spent on a run that could not write')
    // With the fence back, the SAME digest runs.
    st.h.context.api.multitable.records = lockKit.withFakeHostWriteFence(st.records, { lockDb: st.db })
    assert.equal(dataOf(await withEnv(ON, () => execute(st, plan.planDigest))).status, 'completed')
  } finally { st.h.restore() }
  // The source still orders S-001 on its own (its root key is in the current expansion): retiring it would be undone
  // by the next pull.
  const ordered = await mount({ source: F.firstPullSource() })
  try {
    const refused = dataOf(await withEnv(ON, () => preview(ordered)))
    assert.deepEqual([refused.eligible, refused.refusals, refused.counts.stillExpanded], [false, ['old_root_still_expanded'], 4])
    const error = expectRefusal(await withEnv(ON, () => execute(ordered, 'a'.repeat(64))), { status: 409, code: CODES.NOT_APPLICABLE })
    assert.deepEqual(error.details.reasons, ['old_root_still_expanded'])
  } finally { ordered.h.restore() }
  // A person edits an old row while the run is writing: the run stops; the rest needs a new digest and its own claim.
  const moved = await mount()
  try {
    const plan = dataOf(await withEnv(ON, () => preview(moved)))
    let patches = 0
    moved.records.beforePatch = (recordId) => {
      patches += 1
      if (patches !== 2) return
      const row = moved.records.rows.find((entry) => entry.id === recordId)
      row.data[moved.physical('notes')] = 'typed during the run'
      row.version += 1
    }
    const stop = expectRefusal(await withEnv(ON, () => execute(moved, plan.planDigest)), { status: 409, code: CODES.STOPPED, reason: 'version_conflict' })
    assert.deepEqual([stop.details.planned, stop.details.written, stop.details.partial], [4, 1, true])
    assert.deepEqual(moved.runs().map((run) => [run.status, run.stop_reason, run.written_count]), [['stopped', 'version_conflict', 1]])
    assert.equal(moved.lockRow().generation_reason, 'sheet_repair', 'a run that wrote bumps the generation even when it stopped')
    moved.records.beforePatch = null
    expectRefusal(await withEnv(ON, () => execute(moved, plan.planDigest)), { status: 409, code: CODES.ALREADY_CONSUMED })
    const next = dataOf(await withEnv(ON, () => preview(moved)))
    assert.deepEqual([next.eligible, next.sequence, next.counts.toRetire, next.counts.alreadyRetired], [true, 1, 3, 1])
    assert.notEqual(next.planDigest, plan.planDigest)
    assert.equal(dataOf(await withEnv(ON, () => execute(moved, next.planDigest, { approvalRef: 'R-91:syn-window-1b' }))).written, 3)
  } finally { moved.h.restore() }
  // The source cannot be read completely (a BOM line names a part the library does not hold): nothing is retired
  // against an incomplete expansion.
  const incomplete = await mount({ source: F.secondPullSource({ sLine: false, boms: { 'PART-B': [{ part: 'GHOST-1', usage: 1 }] } }) })
  try {
    const refused = dataOf(await withEnv(ON, () => preview(incomplete)))
    assert.deepEqual([refused.eligible, refused.refusals], [false, ['source_incomplete']])
    const error = expectRefusal(await withEnv(ON, () => execute(incomplete, 'a'.repeat(64))), { status: 409, code: CODES.NOT_APPLICABLE })
    assert.deepEqual(error.details.reasons, ['source_incomplete'])
    assert.deepEqual([incomplete.records.calls.includes('patchRecord'), incomplete.runs(), incomplete.claims()], [false, [], []])
  } finally { incomplete.h.restore() }
})

// ── RR-08 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RR-08 the fills report and the run list through their routes: values-free, audited before the answer', async () => {
  const st = await mount()
  try {
    const summary = dataOf(await withEnv(ON, () => call(st, 'GET', PATHS.fills)))
    assert.deepEqual([summary.componentHandle, summary.total, summary.components.length], [null, 1, 1])
    assert.deepEqual([summary.components[0].componentHandle, summary.components[0].shape, summary.components[0].counts.pairs, summary.components[0].counts.k2Carryable, summary.components[0].counts.pairsWithFills, summary.components[0].problems], [HANDLE, 'two_copy', 4, 1, 1, []])
    const detail = dataOf(await withEnv(ON, () => call(st, 'GET', PATHS.fills, { query: { componentHandle: HANDLE, limit: '50' } })))
    assert.deepEqual([detail.found, detail.pairs.length, detail.pairs[0].class, detail.pairs[0].depth, detail.pairs[0].fields.notes, detail.nextCursor], [true, 1, 'k2_carryable', 0, { old: true, copy: false, state: 'carry' }, null])
    assert.match(detail.pairs[0].oldRecordId, /^rec_s_/)
    assert.match(detail.pairs[0].copyRecordId, /^rec_p_/)
    assertValuesFree(summary, st, 'fills summary')
    assertValuesFree(detail, st, 'fills detail')
    const runs = dataOf(await withEnv(ON, () => call(st, 'GET', PATHS.runs)))
    assert.deepEqual(runs, { runs: [], truncated: false })
    assert.deepEqual(st.h.auditAppends.map((entry) => [entry.action, entry.mode]), [['project_board_read', 'sheet_fills_report_read'], ['project_board_read', 'sheet_fills_report_read'], ['project_board_read', 'sheet_repair_runs_read']])
    assert.deepEqual([st.h.auditAppends[1].detail.pairs, st.h.auditAppends[1].detail.pairsWithFills, st.h.auditAppends[1].detail.listing], [4, 1, false])
    assert.equal(JSON.stringify(st.h.auditAppends).includes(PROJECT), false, 'a read\'s audit row names no project')
    assert.deepEqual([st.records.calls.includes('patchRecord'), st.runs(), st.lockRow(), st.sourceState.reads], [false, [], null, 0], 'reads only: no write, no lease, no source read')
    // A refusing audit store: no report.
    st.h.services.stockPreparationAuditStore.append = async () => { throw Object.assign(new Error('audit down'), { status: 503, code: 'AUDIT_STORE_FAILED' }) }
    expectRefusal(await withEnv(ON, () => call(st, 'GET', PATHS.fills)), { status: 503, code: 'AUDIT_STORE_FAILED' })
    expectRefusal(await withEnv(ON, () => call(st, 'GET', PATHS.runs)), { status: 503, code: 'AUDIT_STORE_FAILED' })
  } finally { st.h.restore() }
})

// ── RR-09 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RR-09 the server-held deps the routes hand the library: the fenced patch refuses a missing guard and a missing version before the host; after a takeover the pre-write holder CAS refuses the next patch before it reaches the host; the holder assert the ledger runs is the lock\'s own', async () => {
  const st = await mount()
  const real = R.runSheetRepairRequest
  let deps = null
  // The library entry the route calls is replaced for ONE request: what it is handed are the route's own deps.
  R.runSheetRepairRequest = async (handed) => {
    deps = handed
    return { mode: 'preview' }
  }
  try {
    await withEnv(ON, () => preview(st))
  } finally { R.runSheetRepairRequest = real }
  try {
    assert.ok(deps && typeof deps.patchFor === 'function' && typeof deps.holderWithinFor === 'function' && typeof deps.withLease === 'function')
    // The install gate's reader is ALWAYS bound (ruling C-2) and hands values-free facts, whatever the batch switch says.
    assert.equal(typeof deps.installStateOf, 'function')
    assert.deepEqual(await deps.installStateOf(), { present: false })
    // No guard => no patch function at all, and no holder check (ruling C-4).
    assert.throws(() => deps.patchFor(null), (error) => error.status === 501 && error.code === lockLib.PROJECT_WRITE_ERROR_CODES.UNAVAILABLE && error.details.reason === 'write_fence_required')
    assert.equal(typeof deps.assertHolder, 'function')
    assert.throws(() => deps.assertHolder(null), (error) => error.status === 501 && error.code === lockLib.PROJECT_WRITE_ERROR_CODES.UNAVAILABLE && error.details.reason === 'write_fence_required')
    assert.throws(() => deps.assertHolder({}), (error) => error.status === 501 && error.details.reason === 'write_fence_required')
    const target = st.oldRows()[0]
    const changes = { [st.physical('active')]: false }
    const fences = st.h.context.api.multitable.records.fakeHostFences
    st.clearLogs()
    let taken = false
    const outcome = await withEnv(ON, () => deps.withLease(`${R.SHEET_REPAIR_RUN_ID_PREFIX}00000000-0000-4000-8000-000000000000`, async (guard) => {
      const patch = deps.patchFor(guard)
      // A patch that does not name the version it was planned at is refused before the holder CAS and the host.
      for (const expectedVersion of [undefined, null, 0, '1']) {
        await assert.rejects(patch({ recordId: target.id, changes, expectedVersion }), (error) => error.status === 500 && error.code === CODES.UNAVAILABLE && error.details.field === 'expectedVersion')
      }
      assert.deepEqual([st.records.calls, fences.length, target.version], [[], 0, 1], 'nothing reached the host')
      // The holder check before a ledger transaction is the guard's own pre-write CAS: it passes for the holder ...
      const casBefore = st.lockRow().lease_seq
      await deps.assertHolder(guard)
      assert.equal(st.lockRow().lease_seq, casBefore + 1, 'one holder CAS reached the lock row')
      // The holder assert the ledger transactions run is the lock's own: it passes for the holder ...
      await st.db.transaction((trx) => deps.holderWithinFor(guard)(trx))
      assert.deepEqual(deps.leaseOf(guard), { leaseId: st.lockRow().lease_id, fencingEpoch: st.lockRow().fencing_epoch })
      // ... a pull takes the sheet over (the repair's lease lapsed on its clock) ...
      const other = lockLib.createStockPreparationProjectWriteLock({ db: st.db, now: () => new Date(Date.now() + LAPSED_MS) })
      const taker = other.createGuard(await other.acquire(st.writeScope, { purpose: 'small_apply', runId: 'syn-pull-takeover', tenantId: TENANT }))
      taken = true
      // ... then the SAME assert refuses, and the next patch dies at the pre-write holder CAS: the host never sees it.
      await assert.rejects(st.db.transaction((trx) => deps.holderWithinFor(guard)(trx)), (error) => error.status === 409 && error.code === lockLib.PROJECT_WRITE_ERROR_CODES.LEASE_LOST)
      await assert.rejects(deps.assertHolder(guard), (error) => error.status === 409 && error.code === lockLib.PROJECT_WRITE_ERROR_CODES.LEASE_LOST && error.fence === true)
      await assert.rejects(patch({ recordId: target.id, changes, expectedVersion: 1 }), (error) => error.status === 409 && error.code === lockLib.PROJECT_WRITE_ERROR_CODES.LEASE_LOST && error.fence === true)
      assert.deepEqual([st.records.calls, fences.length, target.version, st.cell(target, 'active')], [[], 0, 1, true], 'the zombie\'s patch never reached the host')
      await taker.release()
      return 'ran'
    })).catch((error) => {
      // The wrapper may report the lost lease at its own release; any other failure is the test's.
      if (error && error.code === lockLib.PROJECT_WRITE_ERROR_CODES.LEASE_LOST) return 'ran'
      throw error
    })
    assert.deepEqual([outcome, taken], ['ran', true])
  } finally { st.h.restore() }
})

// ── RR-10 ────────────────────────────────────────────────────────────────────────────────────────────────

test('RR-10 the tenancy wall: a project whose registry row resolves onto ANOTHER tenant\'s sheet is refused 409 for the preview, the execute, the fills report and the run list, before any sheet, source or ledger read', async () => {
  const OTHER = 'tenant-syn-rpr-other'
  const st = await mount({ seed: false })
  try {
    // The OTHER tenant's sheet, provisioned in ITS staging project; then the caller's registry row is pointed at it
    // (sheet and object both the other tenant's), so neither ownership nor the derived id attributes it to the caller.
    const foreign = st.h.seedRegistryRow(PROJECT, { tenant: OTHER })
    const planted = st.h.registryRows().find((row) => row.tenant_id === OTHER && row.project_no === PROJECT)
    planted.tenant_id = TENANT
    assert.notEqual(foreign.objectId, st.h.projectObjectId(PROJECT), 'the planted object is not the caller\'s derived one')
    st.records.rows.push({ id: 'rec_foreign_1', sheetId: foreign.sheetId, version: 1, createdBy: null, locked: false, data: {} })
    for (const [label, send] of [
      ['preview', () => preview(st)],
      ['execute', () => execute(st, 'a'.repeat(64))],
      ['fills report', () => call(st, 'GET', PATHS.fills)],
      ['run list', () => call(st, 'GET', PATHS.runs)],
    ]) {
      st.clearLogs()
      const res = await withEnv(ON, send)
      const error = expectRefusal(res, { status: 409, code: 'TABLE_ACTION_TARGET_TENANT_MISMATCH' })
      assert.deepEqual({ ...error.details }, { objectId: foreign.objectId }, `${label}: the refusal names only the logical object id`)
      assert.ok(st.h.provisioning.calls.some((entry) => entry[0] === 'isSheetOwnedByProject' && entry[1] === foreign.sheetId && entry[2] === st.h.staging), `${label}: the wall ran on the resolved sheet against the caller's staging project`)
      assert.deepEqual([st.records.calls, st.sourceState.reads, st.db.log, st.auditsWithin, st.h.auditAppends], [[], 0, [], [], []], `${label}: nothing was read or written`)
      const text = JSON.stringify(res.body)
      for (const value of [OTHER, foreign.sheetId, PROJECT]) assert.equal(text.includes(value), false, `${label}: values-free`)
    }
    assert.equal(st.records.rows.find((row) => row.id === 'rec_foreign_1').version, 1, 'the foreign row is untouched')
  } finally { st.h.restore() }
})

// ── RR-11 (ruling C-1) ───────────────────────────────────────────────────────────────────────────────────

test('RR-11 the heartbeat N6 rule through the route: every host patch of the route\'s fenced patch and both ledger transactions of a run are inside the guard\'s host-write bracket', async () => {
  const st = await mount()
  try {
    const plan = dataOf(await withEnv(ON, () => preview(st)))
    assert.deepEqual([st.bracket.patches, st.bracket.holderAsserts], [[], []], 'a preview takes no lease and runs no ledger transaction')
    const done = dataOf(await withEnv(ON, () => execute(st, plan.planDigest)))
    assert.deepEqual([done.status, done.written], ['completed', 4])
    assert.deepEqual(st.bracket.patches, [1, 1, 1, 1], 'sheetRepairFencedPatchFor: every patchRecord ran inside guard.withHostWrite')
    assert.deepEqual(st.bracket.holderAsserts, [['sheet_repair', 1], ['sheet_repair', 1]], 'the begin\'s and the finish\'s holder assert ran inside the bracket')
    assert.equal(st.bracket.depth, 0, 'every bracket closed')
    // The restore of that run: the same.
    st.bracket.patches.length = 0
    st.bracket.holderAsserts.length = 0
    const restorePlan = dataOf(await withEnv(ON, () => repair(st, { mode: 'preview', recipe: RESTORE, runId: done.runId })))
    assert.equal(dataOf(await withEnv(ON, () => repair(st, { mode: 'execute', recipe: RESTORE, runId: done.runId, planDigest: restorePlan.planDigest, approvalRef: 'R-91:syn-window-2' }))).status, 'completed')
    assert.deepEqual([st.bracket.patches, st.bracket.holderAsserts, st.bracket.depth], [[1, 1, 1, 1], [['sheet_repair', 1], ['sheet_repair', 1]], 0])
  } finally { st.h.restore() }
})

// ── RR-12 (ruling C-3) ───────────────────────────────────────────────────────────────────────────────────

test('RR-12 the continuation through the route: a run left `running` after every row was written is verified and closed — no patch, audited, bumped, the batch ledger never read; refused with counts when a row moved; works on a project that became governed', async () => {
  const closePreview = (st, runId) => repair(st, { mode: 'preview', recipe: CLOSE, runId })
  const closeExecute = (st, runId, planDigest, approvalRef = 'R-91:syn-close-1') => repair(st, { mode: 'execute', recipe: CLOSE, runId, planDigest, approvalRef })
  const st = await mount()
  try {
    const runId = await st.leaveRetireOpen()
    // The dead end: every old row retired, the run open, no retire of the component left to begin.
    assert.deepEqual(st.runs().map((run) => [run.id, run.status, run.written_count]), [[runId, 'running', null]])
    for (const row of st.oldRows()) assert.strictEqual(st.cell(row, 'active'), false)
    const retireAgain = dataOf(await withEnv(ON, () => preview(st)))
    assert.deepEqual([retireAgain.eligible, retireAgain.refusals, retireAgain.openRun], [false, ['not_two_copy'], true])
    assert.equal(st.lockRow().generation_reason, null, 'the run never got its bump')
    const rowsBefore = JSON.stringify(st.records.rows)
    st.auditsWithin.length = 0
    st.h.auditAppends.length = 0
    st.bracket.holderAsserts.length = 0
    st.bracket.patches.length = 0
    st.clearLogs()
    const patchesBefore = st.patchCount()
    const sourceReads = st.sourceState.reads
    // The preview: counts and the close's own digest; audited as a read; no lease.
    const plan = dataOf(await withEnv(ON, () => closePreview(st, runId)))
    assert.deepEqual([plan.mode, plan.recipe, plan.runId, plan.runRecipe, plan.eligible, plan.refusals, plan.governed], ['preview', CLOSE, runId, RETIRE, true, [], false])
    assert.deepEqual(plan.counts, { planned: 4, inTargetState: 4, versionMoved: 0, notWritten: 0, moved: 0, missing: 0 })
    assert.deepEqual(plan.requires, { approvalRef: true, planDigest: plan.planDigest })
    assert.notEqual(plan.planDigest, st.runs()[0].plan_digest)
    assert.deepEqual(st.h.auditAppends.map((entry) => [entry.action, entry.mode, entry.detail.operation, entry.projectId === undefined || entry.projectId === null]), [['project_board_read', 'sheet_repair_preview_read', 'sheet_repair_close_preview', true]])
    assert.deepEqual([st.runs()[0].status, st.lockRow().lease_id], ['running', null])
    // The execute.
    const done = dataOf(await withEnv(ON, () => closeExecute(st, runId, plan.planDigest)))
    assert.deepEqual([done.mode, done.recipe, done.runId, done.runRecipe, done.status, done.planned, done.verified, done.governed, done.generationBumped, done.planDigest], ['execute', CLOSE, runId, RETIRE, 'completed', 4, 4, false, true, plan.planDigest])
    // NO row write: no patch reached the host and every stored row is byte-identical.
    assert.deepEqual([st.patchCount(), st.bracket.patches, JSON.stringify(st.records.rows) === rowsBefore], [patchesBefore, [], true])
    // The source was not read, and the batch ledger never asked (the continuation changes nothing on the sheet).
    assert.deepEqual([st.sourceState.reads, st.batchStatements()], [sourceReads, []])
    const run = st.runs()[0]
    assert.deepEqual([run.status, run.stop_reason, run.written_count, run.close_approval_ref, run.approval_ref], ['completed', null, 4, 'R-91:syn-close-1', 'R-91:syn-window-1'])
    assert.equal(st.claims().length, 1, 'the close spent no claim')
    assert.deepEqual(st.auditsWithin.map((entry) => [entry.action, entry.mode, entry.subjectId, entry.projectId, entry.actor, entry.detail.operation, entry.detail.verified, entry.detail.approvalRef, entry.detail.tenantClaimVerified === undefined]), [
      ['exception_resolve', 'sheet_repair_verified_closed', runId, PROJECT, ADMIN.id, 'sheet_repair_verified_close', 4, 'R-91:syn-close-1', false],
    ])
    assert.equal(JSON.stringify(st.auditsWithin.map((entry) => entry.detail)).includes(PROJECT), false)
    assert.deepEqual([st.bracket.holderAsserts, st.bracket.depth], [[['sheet_repair', 1]], 0], 'the close\'s ledger transaction ran inside the host-write bracket (N6)')
    const lockRow = st.lockRow()
    assert.deepEqual([lockRow.lease_id, lockRow.generation_reason, lockRow.generation], [null, 'sheet_repair', 1], 'released, then bumped — the bump the run never got')
    // The run list shows how it was closed.
    const listed = dataOf(await withEnv(ON, () => call(st, 'GET', PATHS.runs)))
    assert.deepEqual(listed.runs.map((entry) => [entry.runId, entry.status, entry.written, entry.approvalRef, entry.closeApprovalRef]), [[runId, 'completed', 4, 'R-91:syn-window-1', 'R-91:syn-close-1']])
    for (const [label, answer] of [['close preview', plan], ['close execute', done], ['runs', listed]]) assertValuesFree(answer, st, label)
    // One-shot by the run's own status.
    const again = expectRefusal(await withEnv(ON, () => closeExecute(st, runId, plan.planDigest)), { status: 409, code: CODES.NOT_APPLICABLE })
    assert.deepEqual(again.details.reasons, ['run_not_open'])
    assert.equal(dataOf(await withEnv(ON, () => preview(st))).openRun, false)
  } finally { st.h.restore() }

  // A planned row moved since (revived by a pull): refused with counts, nothing closed; restoring the run is the way out.
  const moved = await mount()
  try {
    const runId = await moved.leaveRetireOpen()
    const good = dataOf(await withEnv(ON, () => closePreview(moved, runId)))
    assert.equal(good.eligible, true)
    const victim = moved.oldRows()[1]
    Object.assign(victim.data, { [moved.physical('active')]: true, [moved.physical('lastPlmRefreshRunId')]: 'table-action:syn-pull-2', [moved.physical('lastPlmRefreshDecision')]: 'update', [moved.physical('lastPlmConflictSummary')]: '{"type":"plm_system_refresh","changedFields":["material"]}' })
    victim.version += 1
    const refusedPreview = dataOf(await withEnv(ON, () => closePreview(moved, runId)))
    assert.deepEqual([refusedPreview.eligible, refusedPreview.refusals, refusedPreview.planDigest, refusedPreview.counts], [false, ['rows_not_in_target_state'], null, { planned: 4, inTargetState: 3, versionMoved: 0, notWritten: 0, moved: 1, missing: 0 }])
    const error = expectRefusal(await withEnv(ON, () => closeExecute(moved, runId, good.planDigest)), { status: 409, code: CODES.NOT_APPLICABLE })
    assert.deepEqual([Array.from(error.details.reasons), { ...error.details.counts }, error.details.partial], [['rows_not_in_target_state'], { planned: 4, inTargetState: 3, versionMoved: 0, notWritten: 0, moved: 1, missing: 0 }, false])
    assert.deepEqual([moved.runs()[0].status, moved.runs()[0].close_approval_ref, moved.lockRow().lease_id, moved.lockRow().generation_reason], ['running', null, null, null])
    // A digest that is not this close's refuses too (the run's own plan digest included).
    victim.data[moved.physical('active')] = false
    Object.assign(victim.data, { [moved.physical('lastPlmRefreshRunId')]: runId, [moved.physical('lastPlmRefreshDecision')]: 'inactive', [moved.physical('lastPlmConflictSummary')]: R.SHEET_REPAIR_RETIRE_SUMMARY })
    expectRefusal(await withEnv(ON, () => closeExecute(moved, runId, moved.runs()[0].plan_digest)), { status: 409, code: CODES.PLAN_CHANGED, reason: 'plan_digest_differs' })
    assert.equal(moved.runs()[0].status, 'running')
    // While another writer holds the sheet nothing of the continuation runs.
    const holder = await moved.holder('small_apply')
    expectRefusal(await withEnv(ON, () => closePreview(moved, runId)), { status: 409, code: lockLib.PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED })
    expectRefusal(await withEnv(ON, () => closeExecute(moved, runId, good.planDigest)), { status: 409, code: lockLib.PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED })
    await holder.release()
    // The other way out stays: a restore of the run (its begin closes the open run as abandoned).
    const restorePlan = dataOf(await withEnv(ON, () => repair(moved, { mode: 'preview', recipe: RESTORE, runId })))
    assert.equal(dataOf(await withEnv(ON, () => repair(moved, { mode: 'execute', recipe: RESTORE, runId, planDigest: restorePlan.planDigest, approvalRef: 'R-91:syn-window-2' }))).status, 'completed')
    assert.deepEqual(moved.runs().map((run) => [run.recipe, run.status, run.stop_reason]), [[RETIRE, 'stopped', 'abandoned'], [RESTORE, 'completed', null]])
  } finally { moved.h.restore() }

  // The project became GOVERNED since the run: neither recipe can begin, the verified close still works.
  const governed = await mount()
  try {
    const runId = await governed.leaveRetireOpen()
    governed.governed()
    assert.ok(dataOf(await withEnv(ON, () => preview(governed))).refusals.includes('project_governed'))
    assert.deepEqual(dataOf(await withEnv(ON, () => repair(governed, { mode: 'preview', recipe: RESTORE, runId }))).refusals, ['project_governed'])
    const plan = dataOf(await withEnv(ON, () => closePreview(governed, runId)))
    assert.deepEqual([plan.eligible, plan.refusals, plan.governed], [true, [], true])
    const patches = governed.patchCount()
    governed.auditsWithin.length = 0
    const done = dataOf(await withEnv(ON, () => closeExecute(governed, runId, plan.planDigest, 'R-91:syn-close-governed')))
    assert.deepEqual([done.status, done.governed, done.verified, done.generationBumped, governed.patchCount()], ['completed', true, 4, true, patches])
    assert.deepEqual(governed.auditsWithin.map((entry) => [entry.mode, entry.detail.governed]), [['sheet_repair_verified_closed', true]])
    assert.deepEqual([governed.runs()[0].status, governed.runs()[0].close_approval_ref, governed.lockRow().generation_reason], ['completed', 'R-91:syn-close-governed', 'sheet_repair'])
  } finally { governed.h.restore() }

  // The switch off: the continuation is as invisible as the rest of the surface.
  const off = await mount()
  try {
    off.clearLogs()
    expectRefusal(await withEnv({ [REPAIR_ENV]: undefined }, () => closePreview(off, `${R.SHEET_REPAIR_RUN_ID_PREFIX}00000000-0000-4000-8000-000000000000`)), { status: 404, code: CODES.DISABLED })
    off.zeroIo('the continuation with the switch off')
  } finally { off.h.restore() }
})

// ── RR-13 (write-safety review of round 1) ───────────────────────────────────────────────────────────────

/**
 * A sheet that refuses a retire for ONE reason: the preview names the token and its count, the execute of a digest
 * approved while the sheet was clean is 409 inside the lease, and nothing is begun.
 */
async function refusedBoth(st, clean, label, token, countKey) {
  const refused = dataOf(await withEnv(ON, () => preview(st)))
  assert.deepEqual([refused.eligible, refused.refusals, refused.planDigest, refused.counts[countKey]], [false, [token], null, 1], label)
  assertValuesFree(refused, st, label)
  const error = expectRefusal(await withEnv(ON, () => execute(st, clean.planDigest)), { status: 409, code: CODES.NOT_APPLICABLE })
  assert.deepEqual([error.details.reasons, error.details.counts[countKey], error.details.partial], [[token], 1, false], label)
  assertValuesFree(error, st, label)
  assert.deepEqual([st.runs(), st.claims(), st.patchCount()], [[], [], 0], `${label}: no run, no claim, no patch`)
  assert.equal(st.lockRow().lease_id, null, `${label}: the lease is released`)
}

test('RR-13 F-11 on both sides through the route, over the sheet\'s PHYSICAL field ids: a row of the nested copy whose `active` cell is not the boolean true refuses the preview with its count and the execute with 409 — no run, no claim, no patch; put right, the same approved digest runs', async () => {
  const st = await mount()
  try {
    const clean = dataOf(await withEnv(ON, () => preview(st)))
    assert.deepEqual([clean.eligible, clean.refusals, clean.counts.copyRowsNotBooleanActive, clean.counts.pairs], [true, [], 0, 4])
    // The head row of the nested copy, read back through the reader's physical -> logical map.
    const copyHead = st.copyRows().find((row) => st.cell(row, 'componentSourceId') === 'S-001')
    assert.ok(copyHead, 'the nested copy has a head row')
    const activeId = st.physical('active')
    for (const value of ['false', 0, null]) {
      copyHead.data[activeId] = value
      await refusedBoth(st, clean, `the copy's head holds ${JSON.stringify(value)}`, 'copy_row_active_not_boolean', 'copyRowsNotBooleanActive')
    }
    delete copyHead.data[activeId]
    await refusedBoth(st, clean, 'the copy\'s head holds no `active` cell at all', 'copy_row_active_not_boolean', 'copyRowsNotBooleanActive')
    // Put right, and no version moved: the SAME approved digest runs.
    copyHead.data[activeId] = true
    const done = dataOf(await withEnv(ON, () => execute(st, clean.planDigest)))
    assert.deepEqual([done.status, done.planned, done.written], ['completed', 4, 4])
    assert.deepEqual(st.copyRows().map((row) => st.cell(row, 'active')), Array(st.copyRows().length).fill(true), 'every copy row: the boolean true')
    assert.deepEqual(st.oldRows().map((row) => st.cell(row, 'active')), Array(4).fill(false), 'every old row: the boolean false')
  } finally { st.h.restore() }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-sheet-repair-routes.test.cjs', tests)
