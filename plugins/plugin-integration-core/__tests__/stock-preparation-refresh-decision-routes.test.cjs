'use strict'

// Batch-refresh step 4, PR-4 — THE SIX REFRESH DECISION ROUTES (lib/http-routes.cjs stockPreparationRefresh*;
// lib/stock-preparation-refresh-decisions.cjs) on the shared project-sheet substrate with the REAL store, the REAL
// governance reader and the REAL lock over ONE fake db (`lockOnRefreshDb`), so the confirm / end transactions run
// the real composition: state row -> hold -> `bumpGenerationWithin` on the store's transaction handle -> rows ->
// audit on the same handle. Design §8.2-8.4, §13, §23.5 O-17, §23.8 F-15; plan §9.5 U03 / U04, §9.2 E09.
//
//   RT-W1   an unwired governance service: all six answer 501 by name after the gate, before any host work
//   RT-U03  the permission matrix on the real routes: read / operate tier 403 FORBIDDEN; a TENANTLESS platform
//           admin 403 OPERATOR_SCOPE_TENANT_REQUIRED with zero audit rows and zero host work; a steered tenant
//           refused by the scope; another scope's hold / continuation id and an unknown id are the SAME 404;
//           every value read appends exactly one values-free audit row; a sentinel planted in a hold's detail
//           reaches the private page only — never an error detail, never an audit row
//   RT-U04  pagination (holds by cursor, a hold's pairs by pairCursor); the read receipt covers the pages served;
//           a confirm without the receipt / fingerprints / candidateId / acknowledge is 400; an incomplete receipt
//           is 409 READ_RECEIPT_INCOMPLETE; the body cannot carry the end's release precondition (400)
//   RT-C    the confirm: NOT_PILOT; RECOVERY_PENDING; S25 runbook-only hold open (both from the consult, before
//           the state row is taken); STALE (fingerprint, candidate, hold not open); NOT_ALLOWED (kind, not
//           confirmable); WRITE_LOCKED while a lease is live, nothing persisted, then 201 after release with the
//           generation bumped IN the transaction (reason continuation_confirm), the hold resolved,
//           decision_version + 1 and the audit row on the handle
//   RT-C7   S25 UNDER THE LOCK: an escalation lands between the consult and the transaction => the store refuses
//           runbook_only_hold_open under the state-row lock (confirm and re-confirm), nothing persisted
//   RT-C8   RECOVERY_PENDING UNDER THE LOCK: an apply fails and releases in that window => the store re-reads the
//           executions AFTER its bump and refuses; the bump rolls back with it
//   RT-E09  the audit append inside the transaction fails => 503, rollback: no continuation, generation
//           unchanged, hold still open; RT-E09b a COMMIT-time failure => 503 STORE_FAILED `commit`, rollback
//   RT-RC   the re-confirm through the same route (relationship_reconfirm + { id, revision }) => revision 2
//   RT-E    the end: an ACTIVE relationship refused; release decided by the STORE under the lock from THE open
//           relationship_reconfirm row (componentNewPositionCount 0; 1 => new_position_present, absent =>
//           facts_missing), never from the body; escalate keeps the hold runbook-only;
//           superseded_by_new_confirmation is confirm-only
//   RT-E5   a computation lands between the end's consult and its transaction => new_position_present /
//           CONFIRM_STALE facts_moved from the open row under the lock (the release binds to the hold shown)
//   RT-E6   S25 under the lock for a release (another relationship escalated in that window)
//   RT-E7   the body names the hold the page showed (factsHoldId + factsHoldFingerprint): facts_moved otherwise
//   RT-E8   a release naming ANOTHER relationship's admissible row is no_open_hold, byte-identical to an unknown id
//           (step-4 review follow-ups, item 8)
//   RT-K    「暂不处理」: audit only, nothing persisted, STALE on a moved fingerprint
//   RT-EV   the evidence: the demand facts of the computation that opened the hold; history_unknown, then the
//           relationship snapshot once a relationship claims the old root; the continuation detail
//   RT-NG   a registered, NOT-governed project: not_governed, no holds, no receipt, no step-4 row written by a read
//   RT-RP   S1 (review candidate): with the online read-plan switch ON the confirm — and only the confirm — stamps
//           the EFFECTIVE read plan of the hint-less lanes: a candidate (RT-RP1), a re-confirm (RT-RP2), no pointer
//           (RT-RP6), a request workspace hint over R4 bindings (RT-RP8); switch unset no route reads a pointer
//           (RT-RP3); a disabled pointer, an unavailable runtime or a claimless principal refuse the confirm with
//           nothing persisted while the other routes answer as before (RT-RP4, RT-RP5, RT-RP7)
// Synthetic values only; the pilot column is seeded directly (pilot enable is impossible on this build: the
// readiness marker CONTINUATION_SUPPORT_VERSION is 0).

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const harness = require('./support/stock-preparation-project-sheet-harness.cjs')
const refreshKit = require('./support/stock-preparation-refresh-store-kit.cjs')
const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { REFRESH_STORE_TABLES, REFRESH_STORE_ERROR_CODES } = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
const { PROJECT_WRITE_LOCK_TABLE, PROJECT_WRITE_ERROR_CODES, sheetWriteScopeKey } = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const { REFRESH_DECISION_ERROR_CODES, REFRESH_DECISION_AUDIT, READ_RECEIPT_KEY_PREFIX } = require(path.join(LIB, 'stock-preparation-refresh-decisions.cjs'))
const { CONTINUATION_SUPPORT_VERSION } = require(path.join(LIB, 'stock-preparation-continuation-support.cjs'))
const CF = require('./support/stock-preparation-continuation-fixtures.cjs')
const wiring = require('./support/stock-preparation-refresh-governance-wiring.cjs')
const { ONLINE_READ_PLANS_ENABLED_ENV } = require(path.join(LIB, 'stock-preparation-read-plan-switch.cjs'))
const { StockPreparationReadPlanStoreError } = require(path.join(LIB, 'stock-preparation-read-plan-store.cjs'))
const { validateStockPreparationReadPlanConfig } = require(path.join(LIB, 'stock-preparation-read-plan-config.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID, composeStockPreparationReadPlanAction, createStockPreparationTableActionRegistry } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { refreshSourceIdentity } = require(path.join(LIB, 'stock-preparation-refresh-lanes.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant-rd-a'
const OTHER_TENANT = 'tenant-rd-b'
const PROJECT = CF.PROJECT_NO
const BASE = '/api/integration/stock-preparation/projects/:projectNo/refresh'
const PATHS = Object.freeze({
  holds: `${BASE}/holds`,
  evidence: `${BASE}/holds/:holdId/evidence`,
  keep: `${BASE}/holds/:holdId/keep`,
  confirm: `${BASE}/continuations/confirm`,
  detail: `${BASE}/continuations/:id`,
  end: `${BASE}/continuations/:id/end`,
})
const PULLER = Object.freeze({ id: 'u_rd_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const OPERATOR = Object.freeze({ id: 'u_rd_operate', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const READER = Object.freeze({ id: 'u_rd_read', tenantId: TENANT, permissions: [STOCK_PREP_READ] })
const LEGACY_READER = Object.freeze({ id: 'u_rd_legacy', tenantId: TENANT, permissions: ['integration:read'] })
const TENANTLESS_ADMIN = Object.freeze({ id: 'u_rd_platform', roles: ['admin'], permissions: ['integration:admin'] })
const TENANT_ADMIN = Object.freeze({ id: 'u_rd_admin', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] })
const SENTINEL = 'SENTINEL-VALUE-rd-9f3c'
const CODES = REFRESH_DECISION_ERROR_CODES

// A plain-object clone: the route envelope sanitizes details into null-prototype objects.
function errorOf(res) {
  return res.body && res.body.error ? JSON.parse(JSON.stringify(res.body.error)) : {}
}

function dataOf(res) {
  assert.equal(res.statusCode < 300, true, `expected a 2xx, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  return res.body.data
}

function assertNoSentinel(value, label) {
  assert.equal(JSON.stringify(value).includes(SENTINEL), false, `${label}: the sentinel never leaves the private page`)
}

function markPilot(h) {
  for (const row of h.registryRows()) {
    if (row.project_no !== PROJECT) continue
    row.pilot_enabled_at = new Date('2026-10-24T00:00:00Z')
    row.pilot_enabled_by = 'u_rd_admin'
    row.pilot_readiness_version = 1
  }
}

// One mounted stack: the routes, the REAL governance env over one db (store + lock), the registered project.
function mount({ pilot = true, unwired = false, register = true } = {}) {
  const h = harness.mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    switchOn: true,
    refreshOptions: { lockOnRefreshDb: true },
    serviceExtras: {
      stockPreparationConfirmationDecisionLease: { async acquire() { return { leaseId: 'lease_rd' } }, async release() { return true }, async renew() { return true } },
      ...(unwired ? { stockPreparationRefreshGovernance: null } : {}),
    },
  })
  const registered = register ? h.seedRegistryRow(PROJECT) : null
  if (register && pilot) markPilot(h)
  const sheetId = registered ? registered.sheetId : null
  const scope = { tenantId: TENANT, sheetId, projectNo: PROJECT }
  const env = h.refresh
  return {
    h,
    env,
    sheetId,
    scope,
    lockRow: () => (env ? env.rows(PROJECT_WRITE_LOCK_TABLE).find((row) => row.scope_key === sheetWriteScopeKey(sheetId)) || null : null),
    holds: () => (env ? env.rows('hold') : []),
    continuations: () => (env ? env.rows('continuation') : []),
    members: () => (env ? env.rows('member') : []),
    state: () => (env ? env.rows('state')[0] || null : null),
    audits: () => h.auditAppends,
    receipts: () => Array.from(h.context.storage.keys()).filter((key) => String(key).startsWith(READ_RECEIPT_KEY_PREFIX)),
    restore: () => h.restore(),
  }
}

const call = (st, method, routePath, { user = PULLER, body, query = {}, params = {}, authenticatedTenantId } = {}) =>
  harness.call(st.h.routes, method, routePath, { user, body, query, params: { projectNo: PROJECT, ...params }, ...(authenticatedTenantId !== undefined ? { authenticatedTenantId } : {}) })

const listHolds = (st, query = {}, options = {}) => call(st, 'GET', PATHS.holds, { query, ...options })
const evidence = (st, holdId, options = {}) => call(st, 'GET', PATHS.evidence, { params: { holdId }, ...options })
const keep = (st, holdId, body = {}, options = {}) => call(st, 'POST', PATHS.keep, { params: { holdId }, body: { confirmProjectNo: PROJECT, ...body }, ...options })
const detail = (st, id, options = {}) => call(st, 'GET', PATHS.detail, { params: { id }, ...options })
const end = (st, id, body, options = {}) => call(st, 'POST', PATHS.end, { params: { id }, body: { confirmProjectNo: PROJECT, ...body }, ...options })
const confirm = (st, body, options = {}) => call(st, 'POST', PATHS.confirm, { body: { confirmProjectNo: PROJECT, ...body }, ...options })

// Seed the canonical candidate hold (a real continuation_candidate from the pure core) as an open hold.
async function seedCandidate(st, hold) {
  const fixture = await refreshKit.candidateHoldFixture()
  const candidate = hold || fixture.hold
  await st.env.seedHolds(st.scope, [candidate])
  const row = st.holds().find((entry) => entry.fingerprint === candidate.fingerprint && entry.status === 'open')
  assert.ok(row, 'the candidate hold is open')
  return { hold: candidate, row, fixture }
}

// Read the whole hold through the page and answer a confirm body bound to it (receipt included).
async function readAndBind(st, row, hold, { pairLimit } = {}) {
  const first = dataOf(await listHolds(st, pairLimit ? { holdId: row.id, pairLimit } : {}))
  let receipt = first.readReceipt
  const pages = first.page.holds[0].pairPage ? first.page.holds[0].pairPage.count : 1
  for (let index = 1; index < pages; index += 1) {
    const page = dataOf(await listHolds(st, { holdId: row.id, pairCursor: index, ...(pairLimit ? { pairLimit } : {}), receipt: receipt.id }))
    receipt = page.readReceipt
  }
  return {
    receipt,
    body: {
      holdId: row.id,
      holdFingerprint: hold.fingerprint,
      comparisonFingerprint: hold.comparisonFingerprint,
      evidenceFingerprint: hold.evidenceFingerprint,
      candidateId: hold.pairingFingerprint,
      readReceipt: receipt.id,
      basis: { kind: 'puller_confirmed_same_demand', note: 'synthetic basis' },
      acknowledge: { historyUnknown: true },
    },
  }
}

// Whether the request's store transaction took the state row FOR UPDATE (reset `st.env.db.log` before the call): a
// consult-time refusal never does; a refusal decided under the lock always does.
function stateRowTaken(st) {
  return st.env.db.statements('trx.').some(([method, table]) => method === 'trx.selectOneForUpdate' && table === REFRESH_STORE_TABLES.state)
}

// A ONE-SHOT pause on the request's pre-transaction read by id (the kit's `pauses` hook fires for autocommit and
// transaction reads alike, so the shot is spent on the first match — the route's own `readHoldById` /
// `readContinuationById`, which run after the consult and before the store's transaction). What `between` does
// lands exactly in the window the execution review's P6 / P8 / P9 / P11 / P12 constructed.
function pauseBeforeTransaction(st, table, id, between) {
  let armed = true
  st.env.db.pauses.selectOne = async (args) => {
    if (!armed || args.table !== REFRESH_STORE_TABLES[table] || !args.where || args.where.id !== id) return
    armed = false
    await between()
  }
  return () => { delete st.env.db.pauses.selectOne; return armed === false }
}

async function everyRoute(st, options = {}, { holdId = 'hold_rd_absent', continuationId = 'cont_rd_absent' } = {}) {
  return [
    ['holds', await listHolds(st, {}, options)],
    ['evidence', await evidence(st, holdId, options)],
    ['keep', await keep(st, holdId, {}, options)],
    ['confirm', await confirm(st, { holdId, holdFingerprint: 'a'.repeat(64), comparisonFingerprint: 'b'.repeat(64), evidenceFingerprint: 'c'.repeat(64), candidateId: 'd'.repeat(64), readReceipt: 'e'.repeat(32), basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } }, options)],
    ['detail', await detail(st, continuationId, options)],
    ['end', await end(st, continuationId, { revision: 1, outcome: 'escalate_special_repair' }, options)],
  ]
}

// ── RT-W1 ────────────────────────────────────────────────────────────────────────────────────────

test('RT-W1 an UNWIRED governance service: all six routes answer 501 STOCK_PREP_REFRESH_STORE_UNAVAILABLE governance_service after the gate and the scope, with zero audit rows', async () => {
  const st = mount({ unwired: true })
  try {
    for (const [route, res] of await everyRoute(st)) {
      assert.equal(res.statusCode, 501, `${route}: ${JSON.stringify(res.body)}`)
      assert.equal(errorOf(res).code, CODES.STORE_UNAVAILABLE, route)
      assert.equal(errorOf(res).details.reason, 'governance_service', route)
    }
    assert.deepEqual(st.audits(), [])
    for (const [route, res] of await everyRoute(st, { user: OPERATOR })) assert.equal(errorOf(res).code, 'FORBIDDEN', `${route}: the gate still comes first`)
  } finally { st.restore() }
})

// ── RT-U03 ───────────────────────────────────────────────────────────────────────────────────────

test('RT-U03a the tiers: the queue watcher (read), the floor operator (read+operate) and a legacy integration:read holder are 403 FORBIDDEN on all six; anonymous 401; the tenant admin passes the gate', async () => {
  const st = mount()
  try {
    for (const [who, user, code, status] of [['reader', READER, 'FORBIDDEN', 403], ['operator', OPERATOR, 'FORBIDDEN', 403], ['legacy', LEGACY_READER, 'FORBIDDEN', 403], ['anonymous', null, 'UNAUTHENTICATED', 401]]) {
      for (const [route, res] of await everyRoute(st, { user })) {
        assert.equal(res.statusCode, status, `${who} ${route}: ${JSON.stringify(res.body)}`)
        assert.equal(errorOf(res).code, code, `${who} ${route}`)
      }
    }
    assert.deepEqual(st.audits(), [], 'a refused caller writes no audit row')
    assert.equal(st.receipts().length, 0, 'a refused caller gets no receipt')
    for (const [route, res] of await everyRoute(st, { user: TENANT_ADMIN })) assert.notEqual(errorOf(res).code, 'FORBIDDEN', `${route}: the platform admin passes the gate through the ladder`)
  } finally { st.restore() }
})

test('RT-U03b a TENANTLESS platform admin is refused 403 OPERATOR_SCOPE_TENANT_REQUIRED on all six — counts are the board\'s (PR-5), values are never theirs — with zero audit rows, zero host calls, zero receipts', async () => {
  const st = mount()
  try {
    const hostCalls = st.h.provisioning.calls.length + st.h.records.calls.length
    for (const [route, res] of await everyRoute(st, { user: TENANTLESS_ADMIN })) {
      assert.equal(res.statusCode, 403, `${route}: ${JSON.stringify(res.body)}`)
      assert.equal(errorOf(res).code, 'OPERATOR_SCOPE_TENANT_REQUIRED', route)
    }
    assert.deepEqual(st.audits(), [])
    assert.equal(st.h.provisioning.calls.length + st.h.records.calls.length, hostCalls, 'zero host work')
    assert.equal(st.receipts().length, 0)
  } finally { st.restore() }
})

test('RT-U03c a steered tenant (?tenantId / body tenantId naming another tenant, or a header contradicting the verified claim) is refused by the scope on all six, before any host work', async () => {
  const st = mount()
  try {
    const hostCalls = st.h.provisioning.calls.length + st.h.records.calls.length
    for (const [route, res] of await everyRoute(st, { query: { tenantId: OTHER_TENANT } })) {
      if (route === 'holds' || route === 'evidence' || route === 'detail') {
        assert.equal(res.statusCode, 403, `${route}: ${JSON.stringify(res.body)}`)
        assert.match(errorOf(res).code, /^OPERATOR_SCOPE_/, route)
      }
    }
    for (const route of ['keep', 'confirm', 'end']) {
      const res = route === 'keep'
        ? await keep(st, 'hold_rd_absent', { tenantId: OTHER_TENANT })
        : (route === 'end'
          ? await end(st, 'cont_rd_absent', { revision: 1, outcome: 'escalate_special_repair', tenantId: OTHER_TENANT })
          : await confirm(st, { tenantId: OTHER_TENANT, holdId: 'hold_rd_absent', holdFingerprint: 'a', comparisonFingerprint: 'b', evidenceFingerprint: 'c', candidateId: 'd', readReceipt: 'e'.repeat(32), basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } }))
      assert.equal(res.statusCode, 403, `${route}: ${JSON.stringify(res.body)}`)
      assert.match(errorOf(res).code, /^OPERATOR_SCOPE_/, route)
    }
    const contradicted = await listHolds(st, {}, { authenticatedTenantId: OTHER_TENANT })
    assert.equal(contradicted.statusCode, 403)
    assert.equal(errorOf(contradicted).code, 'OPERATOR_SCOPE_TENANT_CONTRADICTED')
    assert.deepEqual(st.audits(), [])
    assert.equal(st.h.provisioning.calls.length + st.h.records.calls.length, hostCalls, 'zero host work')
  } finally { st.restore() }
})

test('RT-U03d by-id reads are never an existence oracle: another tenant\'s hold / continuation (same ids, other scope) and an unknown id answer the SAME 404 on evidence, keep, confirm, detail and end; the typed confirmProjectNo must repeat the path', async () => {
  const st = mount()
  try {
    // Another tenant's rows on another sheet, through the store's own methods (the only writer).
    const foreignScope = { tenantId: OTHER_TENANT, sheetId: 'sheet_rd_foreign', projectNo: PROJECT }
    const fixture = await refreshKit.candidateHoldFixture()
    await st.env.seedHolds(foreignScope, [fixture.hold])
    const foreignHold = st.holds().find((row) => row.tenant_id === OTHER_TENANT)
    const confirmed = await st.env.seedConfirmedContinuation(foreignScope, refreshKit.disjointCandidateHold(fixture.hold), { sourceIdentity: fixture.sourceIdentity })
    const answers = {}
    for (const [label, holdId, continuationId] of [['foreign', foreignHold.id, confirmed.continuationId], ['unknown', 'hold_rd_unknown', 'cont_rd_unknown']]) {
      const out = {}
      out.evidence = errorOf(await evidence(st, holdId)).code
      out.keep = errorOf(await keep(st, holdId)).code
      out.confirm = errorOf(await confirm(st, { holdId, holdFingerprint: 'a'.repeat(64), comparisonFingerprint: 'b'.repeat(64), evidenceFingerprint: 'c'.repeat(64), candidateId: 'd'.repeat(64), readReceipt: 'e'.repeat(32), basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } })).code
      out.detail = errorOf(await detail(st, continuationId)).code
      out.end = errorOf(await end(st, continuationId, { revision: 1, outcome: 'escalate_special_repair' })).code
      answers[label] = out
    }
    assert.deepEqual(answers.foreign, answers.unknown, 'same path, same answer')
    assert.deepEqual(answers.unknown, { evidence: CODES.HOLD_NOT_FOUND, keep: CODES.HOLD_NOT_FOUND, confirm: CODES.HOLD_NOT_FOUND, detail: CODES.CONTINUATION_NOT_FOUND, end: CODES.CONTINUATION_NOT_FOUND })
    assert.deepEqual(st.audits(), [], 'a miss is not a value read')
    // The SAME tenant, another sheet + project (the store answers STALE *_scope, the route the same 404 — review
    // note 6: this leg pins the route-level `/_scope$/` translation; the other tenant's leg pins TENANT_MISMATCH).
    // The other project's holds carry ITS project number in every key (the store refuses HOLD_MALFORMED otherwise).
    const sameTenantScope = { tenantId: TENANT, sheetId: 'sheet_rd_same_tenant', projectNo: 'PRJ-RD-OTHER' }
    const reproject = (hold) => {
      const h = JSON.parse(JSON.stringify(hold).split(PROJECT).join('PRJ-RD-OTHER'))
      h.fingerprint = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs')).holdFingerprint(h)
      return h
    }
    await st.env.seedHolds(sameTenantScope, [reproject(fixture.hold)])
    const sameTenantHold = st.holds().find((row) => row.sheet_id === sameTenantScope.sheetId && row.status === 'open')
    assert.ok(sameTenantHold, 'the other project\'s hold is open on its own sheet')
    const sameTenantCont = await st.env.seedConfirmedContinuation(sameTenantScope, reproject(refreshKit.disjointCandidateHold(fixture.hold)), { sourceIdentity: fixture.sourceIdentity })
    const bodies = {}
    for (const [label, holdId, continuationId] of [['sameTenant', sameTenantHold.id, sameTenantCont.continuationId], ['unknown', 'hold_rd_unknown', 'cont_rd_unknown']]) {
      bodies[label] = {
        evidence: JSON.stringify((await evidence(st, holdId)).body),
        keep: JSON.stringify((await keep(st, holdId)).body),
        confirm: JSON.stringify((await confirm(st, { holdId, holdFingerprint: 'a'.repeat(64), comparisonFingerprint: 'b'.repeat(64), evidenceFingerprint: 'c'.repeat(64), candidateId: 'd'.repeat(64), readReceipt: 'e'.repeat(32), basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } })).body),
        detail: JSON.stringify((await detail(st, continuationId)).body),
        end: JSON.stringify((await end(st, continuationId, { revision: 1, outcome: 'escalate_special_repair' })).body),
        holdsPage: JSON.stringify((await listHolds(st, { holdId })).body),
      }
    }
    assert.deepEqual(bodies.sameTenant, bodies.unknown, 'same tenant, another scope: byte-identical to the unknown-id bodies')
    assert.equal(JSON.parse(bodies.unknown.evidence).error.code, CODES.HOLD_NOT_FOUND)
    assert.equal(JSON.parse(bodies.unknown.holdsPage).error.code, CODES.HOLD_NOT_FOUND)
    assert.deepEqual(st.audits(), [], 'a miss is not a value read')
    const typed = await keep(st, foreignHold.id, { confirmProjectNo: 'PRJ-OTHER' })
    assert.equal(typed.statusCode, 400)
    assert.equal(errorOf(typed).code, CODES.REQUEST_INVALID)
    assert.equal(errorOf(typed).details.field, 'confirmProjectNo')
  } finally { st.restore() }
})

test('RT-U03e every value read appends exactly ONE values-free audit row (project_board_read with its mode) BEFORE the body; a sentinel planted in a hold\'s detail reaches the hold page and the evidence only — never an audit row, never an error detail of any refusal', async () => {
  const st = mount()
  try {
    const fixture = await refreshKit.candidateHoldFixture()
    const planted = { ...fixture.hold, detail: { ...fixture.hold.detail, demand: { ...fixture.hold.detail.demand, oldRoot: { ...fixture.hold.detail.demand.oldRoot, note: SENTINEL } } } }
    planted.fingerprint = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs')).holdFingerprint(planted)
    const { row } = await seedCandidate(st, planted)
    const page = await listHolds(st)
    assert.equal(page.statusCode, 200, JSON.stringify(page.body))
    assert.ok(JSON.stringify(page.body).includes(SENTINEL), 'the private page carries the value')
    assert.equal(st.audits().length, 1)
    assert.equal(st.audits()[0].action, REFRESH_DECISION_AUDIT.readAction)
    assert.equal(st.audits()[0].mode, REFRESH_DECISION_AUDIT.modes.holdRead)
    assert.deepEqual(Object.keys(st.audits()[0].detail).sort(), ['count', 'kinds', 'openHolds', 'operation', 'page', 'pairPage', 'tenantClaimVerified'])
    assertNoSentinel(st.audits(), 'audit')
    const ev = await evidence(st, row.id)
    assert.equal(ev.statusCode, 200, JSON.stringify(ev.body))
    assert.ok(JSON.stringify(ev.body).includes(SENTINEL), 'the evidence carries the value')
    assert.equal(st.audits().length, 2)
    assert.equal(st.audits()[1].mode, REFRESH_DECISION_AUDIT.modes.evidenceRead)
    assertNoSentinel(st.audits(), 'audit')
    // Every refusal of the six routes against this hold: no sentinel in any error.
    const refusals = [
      await confirm(st, { holdId: row.id, holdFingerprint: 'x'.repeat(64), comparisonFingerprint: planted.comparisonFingerprint, evidenceFingerprint: planted.evidenceFingerprint, candidateId: planted.pairingFingerprint, readReceipt: 'e'.repeat(32), basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } }),
      await confirm(st, { holdId: row.id, holdFingerprint: planted.fingerprint, comparisonFingerprint: planted.comparisonFingerprint, evidenceFingerprint: planted.evidenceFingerprint, candidateId: planted.pairingFingerprint, readReceipt: 'e'.repeat(32), basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } }),
      await keep(st, row.id, { holdFingerprint: 'moved' }),
      await end(st, 'cont_rd_absent', { revision: 1, outcome: 'release_to_normal_refresh' }),
      await listHolds(st, { cursor: 'hold_rd_nowhere' }),
    ]
    for (const res of refusals) {
      assert.ok(res.statusCode >= 400, JSON.stringify(res.body))
      assertNoSentinel(res.body, `refusal ${errorOf(res).code}`)
    }
    assertNoSentinel(st.audits(), 'audit after refusals')
    // The audit store refusing => no values served (fail closed): the page is not answered.
    const append = st.h.services.stockPreparationAuditStore.append
    st.h.services.stockPreparationAuditStore.append = async () => { throw Object.assign(new Error('synthetic audit outage'), { status: 503, code: 'AUDIT_STORE_DOWN' }) }
    try {
      const refused = await listHolds(st)
      assert.equal(refused.statusCode, 503)
      assert.equal(errorOf(refused).code, 'AUDIT_STORE_DOWN')
    } finally {
      st.h.services.stockPreparationAuditStore.append = append
    }
  } finally { st.restore() }
})

// ── RT-U04 ───────────────────────────────────────────────────────────────────────────────────────

test('RT-U04a holds are paged by cursor (limit ≤ 50, ordered by opened_at then id): page 1 names its last hold as `next`, page 2 is the rest, an unknown cursor is 400; the refresh summary and holdSetFingerprint are values-free', async () => {
  const st = mount()
  try {
    const fixture = await refreshKit.candidateHoldFixture()
    const extra = (key) => {
      const hold = { kind: 'content_change', confirmable: false, notConfirmableReason: 'needs_step5', subject: { keyDigest: 'c'.repeat(64) + key.slice(-1) }, detail: { recordId: null, recordVersion: null, key, reason: 'plm_system_refresh', fields: {}, inContinuation: null, humanColumnsPresent: {} } }
      hold.fingerprint = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs')).holdFingerprint(hold)
      return hold
    }
    await st.env.seedHolds(st.scope, [fixture.hold, extra('k_rd_1'), extra('k_rd_2')])
    const first = dataOf(await listHolds(st, { limit: 2 }))
    assert.equal(first.page.holds.length, 2)
    assert.equal(first.page.limit, 2)
    assert.equal(first.page.next, first.page.holds[1].id)
    assert.equal(first.refresh.status, 'pending_confirmation')
    assert.equal(first.refresh.governed, 'pilot')
    assert.equal(first.refresh.pilot, true)
    assert.deepEqual(Object.keys(first.refresh).sort(), ['counts', 'decisionVersion', 'governed', 'holdSetFingerprint', 'pilot', 'readable', 'status'])
    assert.match(first.holdSetFingerprint, /^[0-9a-f]{64}$/)
    const second = dataOf(await listHolds(st, { limit: 2, cursor: first.page.next, receipt: first.readReceipt.id }))
    assert.equal(second.page.holds.length, 1)
    assert.equal(second.page.next, null)
    assert.equal(second.readReceipt.id, first.readReceipt.id, 'the receipt is extended across pages')
    assert.equal(Object.keys(second.readReceipt.holds).length, 3, 'every hold served is on the receipt')
    const ids = [...first.page.holds, ...second.page.holds].map((hold) => hold.id)
    assert.deepEqual(ids.slice().sort(), st.holds().map((row) => row.id).sort())
    const unknown = await listHolds(st, { cursor: 'hold_rd_nowhere' })
    assert.equal(unknown.statusCode, 400)
    assert.equal(errorOf(unknown).details.field, 'cursor')
    for (const [query, field] of [[{ limit: 0 }, 'limit'], [{ limit: 51 }, 'limit'], [{ pairLimit: 201 }, 'pairLimit'], [{ pairCursor: 1 }, 'pairCursor'], [{ receipt: 'nope' }, 'receipt']]) {
      const res = await listHolds(st, query)
      assert.equal(res.statusCode, 400, JSON.stringify(query))
      assert.equal(errorOf(res).details.field, field, JSON.stringify(query))
    }
    const extraKey = await listHolds(st, { workspaceId: 'x' })
    assert.equal(extraKey.statusCode, 400, 'an unknown query key is refused by the allow-list')
    assert.equal(st.audits().filter((row) => row.mode === REFRESH_DECISION_AUDIT.modes.holdRead).length, 2, 'two served pages, two audit rows')
    assert.deepEqual(st.audits().map((row) => row.detail.page), [0, 1])
  } finally { st.restore() }
})

test('RT-U04b a hold\'s pairs are paged (pairLimit, pairCursor on one hold); the receipt is complete only once every pair page was served; a confirm on a half-read hold is 409 READ_RECEIPT_INCOMPLETE pages_missing, then 201 after the last page — with the same receipt id', async () => {
  const st = mount()
  try {
    const { hold, row } = await seedCandidate(st)
    assert.equal(hold.detail.pairs.length, 4, 'the canonical candidate has four pairs')
    const first = dataOf(await listHolds(st, { holdId: row.id, pairLimit: 3 }))
    const entry = first.page.holds[0]
    assert.deepEqual(entry.pairPage, { index: 0, count: 2, size: 3, next: 1 })
    assert.equal(entry.candidates.length, 1)
    assert.equal(entry.candidates[0].pairs.length, 3)
    assert.equal(entry.candidates[0].comparison.items.length, 3, 'the comparison items follow the pair page')
    assert.equal(entry.candidates[0].candidateId, hold.pairingFingerprint)
    assert.deepEqual(first.readReceipt.holds[row.id], { pageCount: 2, pagesServed: [0], complete: false })
    const half = await confirm(st, { holdId: row.id, holdFingerprint: hold.fingerprint, comparisonFingerprint: hold.comparisonFingerprint, evidenceFingerprint: hold.evidenceFingerprint, candidateId: hold.pairingFingerprint, readReceipt: first.readReceipt.id, basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } })
    assert.equal(half.statusCode, 409, JSON.stringify(half.body))
    assert.equal(errorOf(half).code, CODES.READ_RECEIPT_INCOMPLETE)
    assert.deepEqual(errorOf(half).details, { reason: 'pages_missing', pagesServed: 1, pageCount: 2, partial: false })
    assert.equal(st.continuations().length, 0, 'nothing confirmed')
    // Review note 0: the audit row is appended BEFORE the receipt records the page. Page 1 requested while the
    // audit store is down => 503 with no body, the stored receipt still says [0], and a confirm is still
    // pages_missing — a page the server refused was never served, so the receipt never vouches for it.
    const append = st.h.services.stockPreparationAuditStore.append
    st.h.services.stockPreparationAuditStore.append = async () => { throw Object.assign(new Error('synthetic audit outage'), { status: 503, code: 'AUDIT_STORE_DOWN' }) }
    try {
      const refused = await listHolds(st, { holdId: row.id, pairLimit: 3, pairCursor: 1, receipt: first.readReceipt.id })
      assert.equal(refused.statusCode, 503, JSON.stringify(refused.body))
      assert.equal(refused.body.data, undefined, 'no body')
    } finally {
      st.h.services.stockPreparationAuditStore.append = append
    }
    const stored = await st.h.context.storage.get(`${READ_RECEIPT_KEY_PREFIX}${first.readReceipt.id}`)
    assert.deepEqual(stored.holds[row.id].pairPagesServed, [0], 'the refused page is not on the receipt')
    const stillHalf = await confirm(st, { holdId: row.id, holdFingerprint: hold.fingerprint, comparisonFingerprint: hold.comparisonFingerprint, evidenceFingerprint: hold.evidenceFingerprint, candidateId: hold.pairingFingerprint, readReceipt: first.readReceipt.id, basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } })
    assert.equal(stillHalf.statusCode, 409, JSON.stringify(stillHalf.body))
    assert.deepEqual(errorOf(stillHalf).details, { reason: 'pages_missing', pagesServed: 1, pageCount: 2, partial: false })
    const second = dataOf(await listHolds(st, { holdId: row.id, pairLimit: 3, pairCursor: 1, receipt: first.readReceipt.id }))
    assert.deepEqual(second.page.holds[0].pairPage, { index: 1, count: 2, size: 3, next: null })
    assert.equal(second.page.holds[0].candidates[0].pairs.length, 1)
    assert.deepEqual(second.readReceipt.holds[row.id], { pageCount: 2, pagesServed: [0, 1], complete: true })
    assert.equal(second.readReceipt.id, first.readReceipt.id)
    const past = await listHolds(st, { holdId: row.id, pairLimit: 3, pairCursor: 2 })
    assert.equal(past.statusCode, 400)
    // A receipt of ANOTHER actor, or one that never saw this hold, is incomplete too.
    const other = dataOf(await listHolds(st, { holdId: row.id, pairLimit: 3 }, { user: TENANT_ADMIN }))
    const foreign = await confirm(st, { holdId: row.id, holdFingerprint: hold.fingerprint, comparisonFingerprint: hold.comparisonFingerprint, evidenceFingerprint: hold.evidenceFingerprint, candidateId: hold.pairingFingerprint, readReceipt: other.readReceipt.id, basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } })
    assert.equal(errorOf(foreign).code, CODES.READ_RECEIPT_INCOMPLETE)
    assert.equal(errorOf(foreign).details.reason, 'receipt_actor')
    const absent = await confirm(st, { holdId: row.id, holdFingerprint: hold.fingerprint, comparisonFingerprint: hold.comparisonFingerprint, evidenceFingerprint: hold.evidenceFingerprint, candidateId: hold.pairingFingerprint, readReceipt: 'f'.repeat(32), basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } })
    assert.equal(errorOf(absent).details.reason, 'receipt_absent')
    const done = await confirm(st, { holdId: row.id, holdFingerprint: hold.fingerprint, comparisonFingerprint: hold.comparisonFingerprint, evidenceFingerprint: hold.evidenceFingerprint, candidateId: hold.pairingFingerprint, readReceipt: second.readReceipt.id, basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } })
    assert.equal(done.statusCode, 201, JSON.stringify(done.body))
    assert.equal(st.continuations().length, 1)
  } finally { st.restore() }
})

test('RT-U04c a confirm without the receipt, a fingerprint, the candidateId or the acknowledgement is 400 before any store read; an unknown body key, and the end\'s release precondition on the body, are 400 by the allow-list', async () => {
  const st = mount()
  try {
    const { hold, row } = await seedCandidate(st)
    const { body } = await readAndBind(st, row, hold)
    const stateBefore = st.env.snapshot()
    for (const [label, mutate, field] of [
      ['no receipt', (b) => { delete b.readReceipt }, 'readReceipt'],
      ['no hold fingerprint', (b) => { delete b.holdFingerprint }, 'holdFingerprint'],
      ['no comparison fingerprint', (b) => { b.comparisonFingerprint = '' }, 'comparisonFingerprint'],
      ['no evidence fingerprint', (b) => { delete b.evidenceFingerprint }, 'evidenceFingerprint'],
      ['no candidateId', (b) => { delete b.candidateId }, 'candidateId'],
      ['no acknowledge', (b) => { delete b.acknowledge }, 'acknowledge.historyUnknown'],
      ['acknowledge false', (b) => { b.acknowledge = { historyUnknown: false } }, 'acknowledge.historyUnknown'],
      ['no basis', (b) => { delete b.basis }, 'basis'],
      ['bad basis', (b) => { b.basis = { kind: 'made_up' } }, 'basis.kind'],
      ['a continuation on a candidate', (b) => { b.continuation = { id: 'cont_x', revision: 1 } }, 'continuation'],
    ]) {
      const mutated = { ...body, basis: { ...body.basis }, acknowledge: { ...body.acknowledge } }
      mutate(mutated)
      const res = await confirm(st, mutated)
      assert.equal(res.statusCode, 400, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(errorOf(res).code, CODES.REQUEST_INVALID, label)
      assert.equal(errorOf(res).details.field, field, label)
    }
    const unknownKey = await confirm(st, { ...body, supersedes: { continuationId: 'x', revision: 1 } })
    assert.equal(unknownKey.statusCode, 400, 'supersedes has no HTTP path in step 4')
    const precondition = await end(st, 'cont_rd_absent', { revision: 1, outcome: 'release_to_normal_refresh', currentExpansionHoldsNoNewPosition: true })
    assert.equal(precondition.statusCode, 400)
    assert.equal(errorOf(precondition).details.field, 'currentExpansionHoldsNoNewPosition')
    // The hold a release decides from MAY be named (review B1; PR-7 sends both keys): accepted by the allow-list
    // and the normalizer (an absent relationship is then the usual 404), refused on another outcome or half given.
    const named = await end(st, 'cont_rd_absent', { revision: 1, outcome: 'release_to_normal_refresh', factsHoldId: 'hold_rd_x', factsHoldFingerprint: 'f'.repeat(64) })
    assert.equal(named.statusCode, 404, JSON.stringify(named.body))
    assert.equal(errorOf(named).code, CODES.CONTINUATION_NOT_FOUND)
    for (const [label, b, field] of [
      ['facts on an escalation', { revision: 1, outcome: 'escalate_special_repair', factsHoldId: 'hold_rd_x', factsHoldFingerprint: 'f'.repeat(64) }, 'factsHoldId'],
      ['facts id only', { revision: 1, outcome: 'release_to_normal_refresh', factsHoldId: 'hold_rd_x' }, 'factsHoldFingerprint'],
      ['facts fingerprint only', { revision: 1, outcome: 'release_to_normal_refresh', factsHoldFingerprint: 'f'.repeat(64) }, 'factsHoldId'],
      ['facts fingerprint typed', { revision: 1, outcome: 'release_to_normal_refresh', factsHoldId: 'hold_rd_x', factsHoldFingerprint: 7 }, 'factsHoldFingerprint'],
    ]) {
      const res = await end(st, 'cont_rd_absent', b)
      assert.equal(res.statusCode, 400, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(errorOf(res).details.field, field, label)
    }
    for (const [label, b] of [['revision 0', { revision: 0, outcome: 'escalate_special_repair' }], ['bad outcome', { revision: 1, outcome: 'made_up' }], ['note not a string', { revision: 1, outcome: 'escalate_special_repair', note: 5 }]]) {
      const res = await end(st, 'cont_rd_absent', b)
      assert.equal(res.statusCode, 400, label)
    }
    assert.equal(st.env.snapshot(), stateBefore, 'nothing persisted by a malformed request')
    assert.equal(st.continuations().length, 0)
  } finally { st.restore() }
})

// ── RT-C: the confirm ────────────────────────────────────────────────────────────────────────────

test('RT-C1 NOT_PILOT: a registered project without the pilot marker (governed by its rows) cannot confirm — 409 STOCK_PREP_CONTINUATION_CONFIRM_NOT_PILOT, nothing persisted; the hold page still serves (protection is pilot-independent)', async () => {
  const st = mount({ pilot: false })
  try {
    const { hold, row } = await seedCandidate(st)
    const { body } = await readAndBind(st, row, hold)
    const before = st.env.snapshot()
    const res = await confirm(st, body)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, CODES.NOT_PILOT)
    assert.deepEqual(errorOf(res).details, { governed: true, partial: false })
    assert.equal(st.env.snapshot(), before)
    const page = dataOf(await listHolds(st))
    assert.equal(page.refresh.governed, 'protected')
    assert.equal(page.refresh.pilot, false)
    assert.equal(page.page.holds.length, 1)
  } finally { st.restore() }
})

test('RT-C2 RECOVERY_PENDING: an execution that did not finish cleanly refuses the confirm AND the end (409 STOCK_PREP_REFRESH_RECOVERY_PENDING, the rows\' count, partial:false) before the transaction; a `running` row of a LIVE lease is exempt (the bump answers WRITE_LOCKED instead)', async () => {
  const st = mount()
  try {
    const { hold, row } = await seedCandidate(st)
    const { body } = await readAndBind(st, row, hold)
    await st.env.seedExecution(st.scope, { status: 'failed' })
    const before = st.env.snapshot()
    st.env.db.log.length = 0
    const res = await confirm(st, body)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, CODES.RECOVERY_PENDING)
    assert.deepEqual(errorOf(res).details, { state: 'failed_pending_recovery', openExecutions: 1, partial: false })
    const ended = await end(st, 'cont_rd_absent', { revision: 1, outcome: 'escalate_special_repair' })
    assert.equal(errorOf(ended).code, CODES.RECOVERY_PENDING)
    assert.equal(st.env.snapshot(), before)
    // Both refused from the consult, before the transaction (the store's in-lock re-check is the second line: RT-C8).
    assert.equal(stateRowTaken(st), false, 'no state row FOR UPDATE on a consult-time refusal')
  } finally { st.restore() }
  // The live-lease exemption: a running row under the lease the routes' lock holds right now.
  const live = mount()
  try {
    const { hold, row } = await seedCandidate(live)
    const { body } = await readAndBind(live, row, hold)
    const lock = live.env.lock()
    const grant = await lock.acquire(sheetWriteScopeKey(live.sheetId), { purpose: 'small_apply', runId: 'rd-live', tenantId: TENANT })
    await live.env.seedExecution(live.scope, { status: 'running', leaseId: grant.leaseId, leaseRunId: 'rd-live' })
    const res = await confirm(live, body)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 'the running row of the live lease is the writer; the bump names it')
    assert.equal(errorOf(res).details.holderPurpose, 'small_apply')
    await lock.createGuard(grant).release()
  } finally { live.restore() }
})

test('RT-C3 (S25) an OPEN runbook-only hold (an escalated relationship): the confirm of another candidate is 409 NOT_ALLOWED runbook_only_hold_open and a release is 409 END_OUTCOME_NOT_ADMISSIBLE runbook_only_hold_open — both from the consult, before the state row is taken; 「暂不处理」 and an escalation stay allowed', async () => {
  const st = mount()
  try {
    const fixture = await refreshKit.candidateHoldFixture()
    // A second relationship (confirmed BEFORE the escalation: the store's own S25, under the lock, refuses a confirm
    // once a runbook-only hold is open — the kit's seeding goes through the store).
    const secondHold = refreshKit.disjointCandidateHold(fixture.hold, { parentId: 'Y-001', suffix: '_rd2' })
    const second = await st.env.seedConfirmedContinuation(st.scope, secondHold, { sourceIdentity: fixture.sourceIdentity })
    const escalated = await st.env.seedEscalatedContinuation(st.scope, fixture.hold, { sourceIdentity: fixture.sourceIdentity })
    assert.ok(st.holds().some((row) => row.status === 'open' && row.runbook_only === true), 'the escalated hold is open, runbook-only')
    // Another, disjoint candidate (other old rows, other new position) is open beside it.
    const other = refreshKit.disjointCandidateHold(fixture.hold)
    await st.env.seedHolds(st.scope, [other], { verdicts: {} })
    const otherRow = st.holds().find((row) => row.fingerprint === other.fingerprint && row.status === 'open')
    assert.ok(otherRow)
    const { body } = await readAndBind(st, otherRow, other)
    const before = st.env.snapshot()
    st.env.db.log.length = 0
    const res = await confirm(st, body)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, CODES.CONFIRM_NOT_ALLOWED)
    assert.deepEqual(errorOf(res).details, { reason: 'runbook_only_hold_open', holdCount: 1, partial: false })
    // The consult-time refusal never takes the state row (the store's in-lock S25 is the second line: RT-C7).
    assert.equal(st.env.db.statements('trx.').some(([method, table]) => method === 'trx.selectOneForUpdate' && table === REFRESH_STORE_TABLES.state), false, 'refused from the consult, before the transaction')
    const kept = await keep(st, otherRow.id)
    assert.equal(kept.statusCode, 200, JSON.stringify(kept.body))
    // The second relationship needs reconfirmation: release refused by S25 (consult-time, no state row), escalate admitted.
    await st.env.seedHolds(st.scope, [refreshKit.reconfirmHoldFor(second.continuationId, { verdict: 'new_position_removed' })], { verdicts: { [second.continuationId]: 'new_position_removed' } })
    st.env.db.log.length = 0
    const release = await end(st, second.continuationId, { revision: 1, outcome: 'release_to_normal_refresh' })
    assert.equal(release.statusCode, 409, JSON.stringify(release.body))
    assert.equal(errorOf(release).code, CODES.END_OUTCOME_NOT_ADMISSIBLE)
    assert.equal(errorOf(release).details.reason, 'runbook_only_hold_open')
    assert.equal(st.env.db.statements('trx.').some(([method, table]) => method === 'trx.selectOneForUpdate' && table === REFRESH_STORE_TABLES.state), false, 'refused from the consult, before the transaction')
    const escalate = await end(st, second.continuationId, { revision: 1, outcome: 'escalate_special_repair', note: 'second' })
    assert.equal(escalate.statusCode, 200, JSON.stringify(escalate.body))
    assert.equal(escalate.body.data.holdsEscalated, 1)
    assert.equal(st.holds().filter((row) => row.status === 'open' && row.runbook_only === true).length, 2)
    void before
    void escalated
  } finally { st.restore() }
})

test('RT-C4 STALE and NOT_ALLOWED: a moved fingerprint, a wrong candidateId, a hold that is no longer open, a content_change hold, a non-confirmable candidate — each refused before the transaction with nothing persisted', async () => {
  const st = mount()
  try {
    const { hold, row } = await seedCandidate(st)
    const { body } = await readAndBind(st, row, hold)
    const before = st.env.snapshot()
    const moved = await confirm(st, { ...body, evidenceFingerprint: 'f'.repeat(64) })
    assert.equal(moved.statusCode, 409)
    assert.equal(errorOf(moved).code, CODES.CONFIRM_STALE)
    // The receipt saw the current fingerprints; the echo does not match them — the receipt check reports it first.
    assert.ok(['fingerprint', 'fingerprint_moved'].includes(errorOf(moved).details.reason), JSON.stringify(errorOf(moved).details))
    const candidate = await confirm(st, { ...body, candidateId: 'g'.repeat(64) })
    assert.equal(errorOf(candidate).code, CODES.CONFIRM_STALE)
    assert.equal(errorOf(candidate).details.reason, 'candidate')
    assert.equal(st.env.snapshot(), before)
    // Kinds without a confirm control.
    const content = refreshKit.contentChangeHoldFor('cont_rd_none')
    const ambiguous = { ...hold, kind: 'candidate_ambiguous', confirmable: false, notConfirmableReason: 'ambiguous_pairing' }
    ambiguous.fingerprint = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs')).holdFingerprint(ambiguous)
    await st.env.seedHolds(st.scope, [hold, content, ambiguous])
    const contentRow = st.holds().find((entry) => entry.fingerprint === content.fingerprint)
    const ambiguousRow = st.holds().find((entry) => entry.fingerprint === ambiguous.fingerprint)
    const kind = await confirm(st, { ...body, holdId: contentRow.id, holdFingerprint: content.fingerprint, comparisonFingerprint: content.comparisonFingerprint, evidenceFingerprint: content.evidenceFingerprint, candidateId: content.pairingFingerprint })
    assert.equal(errorOf(kind).code, CODES.CONFIRM_NOT_ALLOWED)
    assert.deepEqual(errorOf(kind).details, { reason: 'kind', kind: 'relationship_content_change' })
    const ambiguousKind = await confirm(st, { ...body, holdId: ambiguousRow.id, holdFingerprint: ambiguous.fingerprint })
    assert.equal(errorOf(ambiguousKind).code, CODES.CONFIRM_NOT_ALLOWED)
    assert.deepEqual(errorOf(ambiguousKind).details, { reason: 'kind', kind: 'candidate_ambiguous' }, 'a candidate_* kind has no confirm control by kind')
    // A relationship_reconfirm hold that is NOT confirmable (reconfirm_not_admissible): the kind admits a confirm, the row does not.
    const confirmedElsewhere = await st.env.seedConfirmedContinuation(st.scope, refreshKit.disjointCandidateHold(hold), { sourceIdentity: (await refreshKit.candidateHoldFixture()).sourceIdentity })
    const stuck = refreshKit.reconfirmHoldFor(confirmedElsewhere.continuationId, { confirmable: false, verdict: 'structure_changed' })
    await st.env.seedHolds(st.scope, [hold, content, ambiguous, stuck], { verdicts: { [confirmedElsewhere.continuationId]: 'structure_changed' } })
    const stuckRow = st.holds().find((entry) => entry.fingerprint === stuck.fingerprint && entry.status === 'open')
    const notConfirmable = await confirm(st, { ...body, holdId: stuckRow.id, holdFingerprint: stuck.fingerprint, comparisonFingerprint: stuck.comparisonFingerprint, evidenceFingerprint: stuck.evidenceFingerprint, candidateId: undefined, continuation: { id: confirmedElsewhere.continuationId, revision: 1 } })
    assert.equal(errorOf(notConfirmable).code, CODES.CONFIRM_NOT_ALLOWED)
    assert.deepEqual(errorOf(notConfirmable).details, { reason: 'not_confirmable', kind: 'relationship_reconfirm', notConfirmableReason: 'reconfirm_not_admissible' })
    assert.equal(st.continuations().filter((entry) => entry.id !== confirmedElsewhere.continuationId).length, 0, 'no relationship was confirmed by any refusal')
    // Confirm once, then the same body again: the hold is no longer open. (The seeding above re-opened the
    // candidate under a new row id: a computation that did not carry it superseded the first row.)
    const reopened = st.holds().find((entry) => entry.fingerprint === hold.fingerprint && entry.status === 'open')
    const fresh = await readAndBind(st, reopened, hold)
    const done = await confirm(st, fresh.body)
    assert.equal(done.statusCode, 201, JSON.stringify(done.body))
    const again = await confirm(st, fresh.body)
    assert.equal(again.statusCode, 409)
    assert.equal(errorOf(again).code, CODES.CONFIRM_STALE)
    assert.equal(errorOf(again).details.reason, 'hold_not_open')
    assert.equal(st.continuations().filter((entry) => entry.id !== confirmedElsewhere.continuationId).length, 1)
  } finally { st.restore() }
})

test('RT-C6 WRITE_LOCKED while a lease is live (I2): the confirm transaction is rolled back — no continuation, hold open, generation and decision_version unchanged, no audit row; after release the confirm commits: generation + 1 with reason continuation_confirm IN the transaction, members written, hold resolved, decision_version 1, the audit row on the transaction handle, 201 with values-free body', async () => {
  const st = mount()
  try {
    const { hold, row } = await seedCandidate(st)
    const { body } = await readAndBind(st, row, hold)
    const lock = st.env.lock()
    const scopeKey = sheetWriteScopeKey(st.sheetId)
    await lock.bumpGeneration(scopeKey, { reason: 'small_preview', tenantId: TENANT })
    const gen0 = st.lockRow()
    const grant = await lock.acquire(scopeKey, { purpose: 'small_apply', runId: 'rd-c6', tenantId: TENANT })
    const auditsBefore = st.audits().length
    const stepFourBefore = st.env.snapshot()
    const locked = await confirm(st, body)
    assert.equal(locked.statusCode, 409, JSON.stringify(locked.body))
    assert.equal(errorOf(locked).code, PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
    assert.equal(errorOf(locked).details.holderPurpose, 'small_apply')
    assert.equal(st.env.snapshot(), stepFourBefore, 'the transaction rolled back')
    assert.equal(st.lockRow().generation, gen0.generation)
    assert.equal(st.lockRow().lease_id, grant.leaseId, 'the holder keeps its lease')
    assert.equal(st.audits().length, auditsBefore, 'no audit row for a rolled-back decision')
    await lock.createGuard(grant).release()
    const done = await confirm(st, body)
    assert.equal(done.statusCode, 201, JSON.stringify(done.body))
    assert.deepEqual(Object.keys(done.body.data).sort(), ['continuationId', 'decisionVersion', 'generation', 'holdId', 'memberCount', 'nextStep', 'revision', 'state'])
    assert.equal(done.body.data.state, 'confirmed_pending_execution')
    assert.equal(done.body.data.nextStep, 'preview_again')
    assert.equal(done.body.data.memberCount, 4)
    assert.equal(done.body.data.revision, 1)
    assert.equal(done.body.data.decisionVersion, 1)
    const lockRow = st.lockRow()
    assert.equal(lockRow.generation, gen0.generation + 1)
    assert.equal(lockRow.generation_reason, 'continuation_confirm')
    assert.notEqual(lockRow.generation_token, gen0.generation_token)
    assert.equal(lockRow.lease_id, null)
    assert.equal(done.body.data.generation, lockRow.generation)
    const cont = st.continuations()[0]
    assert.equal(cont.status, 'active')
    assert.equal(cont.confirmed_by, PULLER.id)
    assert.equal(cont.confirmed_generation_token, lockRow.generation_token, 'the bump THIS confirm issued')
    assert.equal(cont.basis_note, 'synthetic basis')
    assert.equal(st.members().length, 4)
    assert.equal(st.holds().find((entry) => entry.id === row.id).status, 'resolved')
    assert.equal(st.state().decision_version, 1)
    const decisionAudits = st.audits().slice(auditsBefore).filter((entry) => entry.action === REFRESH_DECISION_AUDIT.decisionAction)
    assert.equal(decisionAudits.length, 1)
    assert.equal(decisionAudits[0].mode, REFRESH_DECISION_AUDIT.modes.confirmed)
    assert.equal(decisionAudits[0].subjectId, cont.id)
    assert.equal(decisionAudits[0].actor, PULLER.id)
    assert.deepEqual(decisionAudits[0].detail, { operation: 'continuation_confirmed', revision: 1, memberCount: 4, comparisonOutcome: 'match', historyStatus: 'history_unknown', holdCount: 1, tenantClaimVerified: false })
    // The audit row rode the store's transaction handle: the fake db logged a commit after the appendWithin.
    const log = st.env.db.log.map(([method]) => method)
    assert.ok(log.includes('commit'))
    assertNoSentinel(done.body, 'confirm body')
  } finally { st.restore() }
})

test('RT-E09 the audit append INSIDE the transaction fails => 503 STORE_FAILED (audit), and the whole decision rolls back: no continuation, no member, the hold still open, decision_version unchanged, the generation unchanged (the bump rolled back with it)', async () => {
  const st = mount()
  try {
    const { hold, row } = await seedCandidate(st)
    const { body } = await readAndBind(st, row, hold)
    await st.env.lock().bumpGeneration(sheetWriteScopeKey(st.sheetId), { reason: 'small_preview', tenantId: TENANT })
    const gen0 = { ...st.lockRow() }
    const before = st.env.snapshot()
    const store = st.h.services.stockPreparationAuditStore
    const appendWithin = store.appendWithin
    store.appendWithin = async () => { throw Object.assign(new Error('synthetic audit insert failure'), { code: '42501' }) }
    try {
      const res = await confirm(st, body)
      assert.equal(res.statusCode, 503, JSON.stringify(res.body))
      assert.equal(errorOf(res).code, REFRESH_STORE_ERROR_CODES.STORE_FAILED)
      assert.deepEqual(errorOf(res).details, { operation: 'audit', sqlState: '42501', partial: false })
    } finally {
      store.appendWithin = appendWithin
    }
    assert.equal(st.env.snapshot(), before, 'every step-4 row as before')
    assert.equal(st.continuations().length, 0)
    assert.equal(st.holds().find((entry) => entry.id === row.id).status, 'open')
    assert.deepEqual({ generation: st.lockRow().generation, token: st.lockRow().generation_token }, { generation: gen0.generation, token: gen0.generation_token }, 'the bump rolled back')
    assert.equal(st.env.db.log.map(([method]) => method).filter((method) => method === 'rollback').length >= 1, true)
    // And the control: with the audit back, the same body commits.
    const done = await confirm(st, body)
    assert.equal(done.statusCode, 201, JSON.stringify(done.body))
    assert.equal(st.lockRow().generation, gen0.generation + 1)
  } finally { st.restore() }
})

test('RT-E09b the transaction fails AT COMMIT (a deferred constraint, a connection lost at commit — review P7): the store answers 503 STORE_FAILED { operation: commit, sqlState } instead of a generic 500, every step-4 row and the generation as before (the bump rolled back); the same body then commits', async () => {
  const st = mount()
  try {
    const { hold, row } = await seedCandidate(st)
    const { body } = await readAndBind(st, row, hold)
    await st.env.lock().bumpGeneration(sheetWriteScopeKey(st.sheetId), { reason: 'small_preview', tenantId: TENANT })
    const gen0 = { generation: st.lockRow().generation, token: st.lockRow().generation_token }
    const before = st.env.snapshot()
    // Armed after the route's consult (its own transaction) and before the store's: the decision's COMMIT fails.
    const release = pauseBeforeTransaction(st, 'hold', row.id, async () => {
      st.env.db.faults.commit = Object.assign(new Error('synthetic commit-time failure'), { code: '42501' })
    })
    const res = await confirm(st, body)
    assert.equal(release(), true)
    assert.equal(st.env.db.faults.commit, undefined, 'the one-shot fault fired')
    assert.equal(res.statusCode, 503, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, REFRESH_STORE_ERROR_CODES.STORE_FAILED)
    assert.deepEqual(errorOf(res).details, { operation: 'commit', sqlState: '42501', partial: false })
    assert.equal(st.env.snapshot(), before, 'every step-4 row as before')
    assert.equal(st.continuations().length, 0)
    assert.equal(st.holds().find((entry) => entry.id === row.id).status, 'open')
    assert.deepEqual({ generation: st.lockRow().generation, token: st.lockRow().generation_token }, gen0, 'the bump rolled back')
    const done = await confirm(st, body)
    assert.equal(done.statusCode, 201, JSON.stringify(done.body))
    assert.equal(st.lockRow().generation, gen0.generation + 1)
  } finally { st.restore() }
})

test('RT-C7 S25 UNDER THE LOCK (review N2 / P9): another relationship is escalated — its hold turns runbook-only — between the confirm\'s consult and its transaction; the store refuses 409 CONFIRM_NOT_ALLOWED runbook_only_hold_open under the state-row lock, nothing confirmed, no bump; the re-confirm path likewise', async () => {
  const st = mount()
  try {
    const fixture = await refreshKit.candidateHoldFixture()
    const second = refreshKit.disjointCandidateHold(fixture.hold)
    const confirmed2 = await st.env.seedConfirmedContinuation(st.scope, second, { sourceIdentity: fixture.sourceIdentity })
    const reconfirm2 = refreshKit.reconfirmHoldFor(confirmed2.continuationId)
    await st.env.seedHolds(st.scope, [fixture.hold, reconfirm2], { verdicts: { [confirmed2.continuationId]: 'source_scope_changed' } })
    const row = st.holds().find((entry) => entry.fingerprint === fixture.hold.fingerprint && entry.status === 'open')
    const { body } = await readAndBind(st, row, fixture.hold)
    const lock0 = JSON.stringify(st.lockRow())
    let interleaved = null
    const release = pauseBeforeTransaction(st, 'hold', row.id, async () => {
      await st.env.store.endContinuation({ ...st.scope, continuationId: confirmed2.continuationId, revision: 1, outcome: 'escalate_special_repair', endedBy: 'u_rd_other' }, { bumpWithin: (trx, key, options) => st.env.lock().bumpGenerationWithin(trx, key, options) })
      interleaved = { runbookOpen: st.holds().filter((entry) => entry.status === 'open' && entry.runbook_only === true).length, snapshot: st.env.snapshot(), lock: JSON.stringify(st.lockRow()) }
      st.env.db.log.length = 0
    })
    const res = await confirm(st, body)
    assert.equal(release(), true, 'the pause fired once')
    assert.equal(interleaved.runbookOpen, 1)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, CODES.CONFIRM_NOT_ALLOWED)
    assert.deepEqual(errorOf(res).details, { reason: 'runbook_only_hold_open', holdCount: 1, partial: false })
    assert.equal(stateRowTaken(st), true, 'decided under the lock — the consult saw no runbook-only hold')
    assert.equal(st.env.snapshot(), interleaved.snapshot, 'nothing confirmed')
    assert.equal(JSON.stringify(st.lockRow()), interleaved.lock, 'no bump (refused before it)')
    assert.notEqual(JSON.stringify(st.lockRow()), lock0, 'the escalation itself did bump')
    assert.equal(st.continuations().filter((entry) => entry.status === 'active').length, 0)
    assert.equal(st.audits().filter((entry) => entry.mode === REFRESH_DECISION_AUDIT.modes.confirmed).length, 0)
  } finally { st.restore() }
  // The re-confirm path: the relationship_reconfirm hold of relationship B confirmed while A is escalated in the gap.
  const rc = mount()
  try {
    const fixture = await refreshKit.candidateHoldFixture()
    const a = await rc.env.seedConfirmedContinuation(rc.scope, fixture.hold, { sourceIdentity: fixture.sourceIdentity })
    const b = await rc.env.seedConfirmedContinuation(rc.scope, refreshKit.disjointCandidateHold(fixture.hold), { sourceIdentity: fixture.sourceIdentity })
    const reconfirmA = refreshKit.reconfirmHoldFor(a.continuationId)
    const reconfirmB = refreshKit.reconfirmHoldFor(b.continuationId)
    await rc.env.seedHolds(rc.scope, [reconfirmA, reconfirmB], { verdicts: { [a.continuationId]: 'source_scope_changed', [b.continuationId]: 'source_scope_changed' } })
    const rowB = rc.holds().find((entry) => entry.fingerprint === reconfirmB.fingerprint && entry.status === 'open')
    const page = dataOf(await listHolds(rc))
    const release = pauseBeforeTransaction(rc, 'hold', rowB.id, async () => {
      await rc.env.store.endContinuation({ ...rc.scope, continuationId: a.continuationId, revision: 1, outcome: 'escalate_special_repair', endedBy: 'u_rd_other' }, { bumpWithin: (trx, key, options) => rc.env.lock().bumpGenerationWithin(trx, key, options) })
      rc.env.db.log.length = 0
    })
    const res = await confirm(rc, { holdId: rowB.id, holdFingerprint: reconfirmB.fingerprint, comparisonFingerprint: reconfirmB.comparisonFingerprint, evidenceFingerprint: reconfirmB.evidenceFingerprint, continuation: { id: b.continuationId, revision: 1 }, readReceipt: page.readReceipt.id, acknowledge: { historyUnknown: true } })
    assert.equal(release(), true)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).details.reason, 'runbook_only_hold_open')
    assert.equal(stateRowTaken(rc), true)
    assert.equal(rc.continuations().find((entry) => entry.id === b.continuationId).status, 'needs_reconfirmation')
    assert.equal(rc.continuations().find((entry) => entry.id === b.continuationId).revision, 1)
  } finally { rc.restore() }
})

test('RT-C8 RECOVERY_PENDING UNDER THE LOCK (review N3 / P6): an apply begins, fails and releases its lease between the confirm\'s consult and its transaction; the store re-reads the executions AFTER its bump and refuses 409 STOCK_PREP_REFRESH_RECOVERY_PENDING — the bump rolled back with it (generation unchanged), nothing confirmed', async () => {
  const st = mount()
  try {
    const { hold, row } = await seedCandidate(st)
    const { body } = await readAndBind(st, row, hold)
    await st.env.lock().bumpGeneration(sheetWriteScopeKey(st.sheetId), { reason: 'small_preview', tenantId: TENANT })
    const gen0 = { generation: st.lockRow().generation, token: st.lockRow().generation_token }
    let interleaved = null
    const release = pauseBeforeTransaction(st, 'hold', row.id, async () => {
      // The apply of another session: a lease, an execution that fails, the lease released — all before the confirm's transaction.
      const lock = st.env.lock()
      const grant = await lock.acquire(sheetWriteScopeKey(st.sheetId), { purpose: 'small_apply', runId: 'rd-c8-apply', tenantId: TENANT })
      await st.env.seedExecution(st.scope, { status: 'failed', leaseId: grant.leaseId, leaseRunId: 'rd-c8-apply' })
      await lock.createGuard(grant).release()
      interleaved = { snapshot: st.env.snapshot(), leaseFree: st.lockRow().lease_id === null }
      st.env.db.log.length = 0
    })
    const res = await confirm(st, body)
    assert.equal(release(), true, 'the pause fired once')
    assert.equal(interleaved.leaseFree, true)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, CODES.RECOVERY_PENDING)
    assert.deepEqual(errorOf(res).details, { state: 'failed_pending_recovery', openExecutions: 1, partial: false })
    assert.equal(stateRowTaken(st), true, 'decided under the lock — the consult saw no unfinished execution')
    const trx = st.env.db.statements('trx.').map(([method, table]) => `${method}:${table}`)
    assert.ok(trx.includes(`trx.updateRow:${PROJECT_WRITE_LOCK_TABLE}`), 'the bump ran inside the transaction')
    assert.ok(trx.indexOf(`trx.select:${REFRESH_STORE_TABLES.execution}`) > trx.indexOf(`trx.updateRow:${PROJECT_WRITE_LOCK_TABLE}`), 'the executions are re-read AFTER the bump')
    assert.equal(st.env.snapshot(), interleaved.snapshot, 'nothing confirmed')
    assert.deepEqual({ generation: st.lockRow().generation, token: st.lockRow().generation_token }, gen0, 'the bump rolled back')
    assert.equal(st.env.db.log.map(([method]) => method).filter((method) => method === 'rollback').length >= 1, true)
    assert.equal(st.holds().find((entry) => entry.id === row.id).status, 'open')
  } finally { st.restore() }
})

// ── RT-RC: the re-confirm ────────────────────────────────────────────────────────────────────────

test('RT-RC a relationship_reconfirm hold is confirmed through the SAME route with { continuation: { id, revision } } (no candidateId, no basis): revision 2, active, the hold resolved, reason continuation_confirm; a candidateId on it, a wrong id or a wrong revision are refused', async () => {
  const st = mount()
  try {
    const fixture = await refreshKit.candidateHoldFixture()
    const confirmed = await st.env.seedConfirmedContinuation(st.scope, fixture.hold, { sourceIdentity: fixture.sourceIdentity })
    const reconfirm = refreshKit.reconfirmHoldFor(confirmed.continuationId, { verdict: 'source_scope_changed' })
    await st.env.seedHolds(st.scope, [reconfirm], { verdicts: { [confirmed.continuationId]: 'source_scope_changed' } })
    assert.equal(st.continuations()[0].status, 'needs_reconfirmation')
    const row = st.holds().find((entry) => entry.fingerprint === reconfirm.fingerprint && entry.status === 'open')
    const page = dataOf(await listHolds(st))
    const entry = page.page.holds.find((item) => item.id === row.id)
    assert.equal(entry.kind, 'relationship_reconfirm')
    assert.equal(entry.verification.verdict, 'source_scope_changed')
    assert.deepEqual(entry.candidates, [])
    const base = { holdId: row.id, holdFingerprint: reconfirm.fingerprint, comparisonFingerprint: reconfirm.comparisonFingerprint, evidenceFingerprint: reconfirm.evidenceFingerprint, readReceipt: page.readReceipt.id, acknowledge: { historyUnknown: true } }
    const withCandidate = await confirm(st, { ...base, candidateId: 'x'.repeat(64), continuation: { id: confirmed.continuationId, revision: 1 } })
    assert.equal(withCandidate.statusCode, 400)
    assert.equal(errorOf(withCandidate).details.field, 'candidateId')
    const noContinuation = await confirm(st, base)
    assert.equal(noContinuation.statusCode, 400)
    assert.equal(errorOf(noContinuation).details.field, 'continuation')
    const wrongId = await confirm(st, { ...base, continuation: { id: 'cont_rd_other', revision: 1 } })
    assert.equal(errorOf(wrongId).code, CODES.CONFIRM_STALE)
    assert.equal(errorOf(wrongId).details.reason, 'continuation')
    const wrongRevision = await confirm(st, { ...base, continuation: { id: confirmed.continuationId, revision: 2 } })
    assert.equal(errorOf(wrongRevision).code, CODES.CONFIRM_STALE)
    assert.equal(errorOf(wrongRevision).details.reason, 'continuation_revision')
    const done = await confirm(st, { ...base, continuation: { id: confirmed.continuationId, revision: 1 } })
    assert.equal(done.statusCode, 201, JSON.stringify(done.body))
    assert.equal(done.body.data.revision, 2)
    assert.equal(done.body.data.continuationId, confirmed.continuationId)
    assert.equal(st.continuations()[0].status, 'active')
    assert.equal(st.continuations()[0].revision, 2)
    assert.equal(st.holds().find((item) => item.id === row.id).status, 'resolved')
    assert.equal(st.lockRow().generation_reason, 'continuation_confirm')
    const audit = st.audits().filter((item) => item.mode === REFRESH_DECISION_AUDIT.modes.reconfirmed)
    assert.equal(audit.length, 1)
    assert.equal(audit[0].detail.previousStatusReason, 'source_scope_changed')
  } finally { st.restore() }
})

// ── RT-E: the end ────────────────────────────────────────────────────────────────────────────────

async function needsReconfirmation(st, { count, verdict = 'new_position_removed' } = {}) {
  const fixture = await refreshKit.candidateHoldFixture()
  const confirmed = await st.env.seedConfirmedContinuation(st.scope, fixture.hold, { sourceIdentity: fixture.sourceIdentity })
  const hold = refreshKit.reconfirmHoldFor(confirmed.continuationId, { confirmable: false, verdict })
  if (count !== undefined) hold.detail = { ...hold.detail, componentNewPositionCount: count }
  hold.fingerprint = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs')).holdFingerprint(hold)
  await st.env.seedHolds(st.scope, [hold], { verdicts: { [confirmed.continuationId]: verdict } })
  return { confirmed, hold }
}

test('RT-E1 an ACTIVE relationship cannot be ended here (409 END_OUTCOME_NOT_ADMISSIBLE status); superseded_by_new_confirmation is confirm-only (outcome_confirm_only); a wrong revision is STALE — nothing persisted, no bump', async () => {
  const st = mount()
  try {
    const fixture = await refreshKit.candidateHoldFixture()
    const confirmed = await st.env.seedConfirmedContinuation(st.scope, fixture.hold, { sourceIdentity: fixture.sourceIdentity })
    const before = st.env.snapshot()
    const lock0 = JSON.stringify(st.lockRow())
    const active = await end(st, confirmed.continuationId, { revision: 1, outcome: 'escalate_special_repair' })
    assert.equal(active.statusCode, 409, JSON.stringify(active.body))
    assert.equal(errorOf(active).code, CODES.END_OUTCOME_NOT_ADMISSIBLE)
    assert.equal(errorOf(active).details.reason, 'status')
    const superseded = await end(st, confirmed.continuationId, { revision: 1, outcome: 'superseded_by_new_confirmation' })
    assert.equal(errorOf(superseded).details.reason, 'outcome_confirm_only')
    const revision = await end(st, confirmed.continuationId, { revision: 7, outcome: 'escalate_special_repair' })
    assert.equal(errorOf(revision).code, CODES.CONFIRM_STALE)
    assert.equal(st.env.snapshot(), before)
    assert.equal(JSON.stringify(st.lockRow()), lock0, 'no bump')
    assert.equal(st.audits().filter((item) => item.action === REFRESH_DECISION_AUDIT.decisionAction).length, 0)
  } finally { st.restore() }
})

test('RT-E2/E3 release_to_normal_refresh is admissible ONLY from the recorded facts: componentNewPositionCount 1 => 409 new_position_present (whatever the body says); absent => 409 facts_missing; another verdict => last_verdict; 0 => 200 ended, members released, the hold resolved, generation bumped with reason continuation_end, one audit row on the handle', async () => {
  for (const [label, count, verdict, expected] of [
    ['position present', 1, 'new_position_removed', { status: 409, reason: 'new_position_present' }],
    ['facts missing', undefined, 'new_position_removed', { status: 409, reason: 'facts_missing' }],
    ['other verdict', 0, 'structure_changed', { status: 409, reason: 'last_verdict' }],
    ['no position', 0, 'new_position_removed', { status: 200 }],
  ]) {
    const st = mount()
    try {
      const { confirmed } = await needsReconfirmation(st, { count, verdict })
      const before = st.env.snapshot()
      const gen0 = st.lockRow() ? st.lockRow().generation : 0
      const lock0 = JSON.stringify(st.lockRow())
      st.env.db.log.length = 0
      const res = await end(st, confirmed.continuationId, { revision: 1, outcome: 'release_to_normal_refresh', note: 'release' })
      assert.equal(res.statusCode, expected.status, `${label}: ${JSON.stringify(res.body)}`)
      if (expected.status === 409) {
        assert.equal(errorOf(res).code, CODES.END_OUTCOME_NOT_ADMISSIBLE, label)
        assert.equal(errorOf(res).details.reason, expected.reason, label)
        assert.equal(errorOf(res).details.outcome, 'release_to_normal_refresh', label)
        if (expected.reason === 'new_position_present') assert.equal(errorOf(res).details.componentNewPositionCount, 1, label)
        if (expected.reason === 'last_verdict') assert.deepEqual([errorOf(res).details.lastVerdict, errorOf(res).details.recordedVerdict], ['structure_changed', 'structure_changed'], label)
        // Decided by the STORE from the open row under the lock (review B1): the state row was taken.
        assert.equal(stateRowTaken(st), true, `${label}: decided under the lock`)
        assert.equal(st.env.snapshot(), before, `${label}: nothing persisted`)
        assert.equal(st.continuations()[0].status, 'needs_reconfirmation', label)
        assert.equal(JSON.stringify(st.lockRow()), lock0, `${label}: no bump`)
      } else {
        assert.deepEqual(res.body.data, { continuationId: confirmed.continuationId, status: 'ended', endedOutcome: 'release_to_normal_refresh', holdsResolved: 1, holdsEscalated: 0, decisionVersion: 2, nextStep: 'preview_again' })
        const cont = st.continuations()[0]
        assert.equal(cont.status, 'ended')
        assert.equal(cont.claim_active, false)
        assert.equal(cont.ended_outcome, 'release_to_normal_refresh')
        assert.equal(cont.ended_by, PULLER.id)
        assert.ok(st.members().every((member) => member.claim_active === false))
        assert.equal(st.holds().filter((row) => row.status === 'open').length, 0)
        assert.equal(st.lockRow().generation, gen0 + 1)
        assert.equal(st.lockRow().generation_reason, 'continuation_end')
        const audits = st.audits().filter((item) => item.mode === REFRESH_DECISION_AUDIT.modes.ended)
        assert.equal(audits.length, 1)
        assert.deepEqual(audits[0].detail, { operation: 'continuation_ended', revision: 1, endedOutcome: 'release_to_normal_refresh', holdsResolved: 1, holdsEscalated: 0, tenantClaimVerified: false })
        assert.equal(audits[0].subjectId, confirmed.continuationId)
      }
    } finally { st.restore() }
  }
})

test('RT-E4 escalate_special_repair keeps the relationship\'s hold OPEN and runbook-only (the project stays pending_confirmation); without an open hold about it the escalation is refused no_open_hold', async () => {
  const st = mount()
  try {
    const { confirmed, hold } = await needsReconfirmation(st, { count: 1 })
    const res = await end(st, confirmed.continuationId, { revision: 1, outcome: 'escalate_special_repair', note: 'specialist' })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.holdsEscalated, 1)
    const row = st.holds().find((entry) => entry.fingerprint === hold.fingerprint)
    assert.equal(row.status, 'open')
    assert.equal(row.runbook_only, true)
    assert.equal(row.confirmable, false)
    const page = dataOf(await listHolds(st))
    assert.equal(page.refresh.status, 'pending_confirmation')
    assert.equal(page.page.holds[0].runbookOnly, true)
    assert.equal(st.lockRow().generation_reason, 'continuation_end')
  } finally { st.restore() }
  const bare = mount()
  try {
    const fixture = await refreshKit.candidateHoldFixture()
    const confirmed = await bare.env.seedConfirmedContinuation(bare.scope, fixture.hold, { sourceIdentity: fixture.sourceIdentity })
    // needs_reconfirmation without an open hold (the hold superseded by a later computation).
    await bare.env.seedHolds(bare.scope, [refreshKit.reconfirmHoldFor(confirmed.continuationId, { confirmable: false, verdict: 'structure_changed' })], { verdicts: { [confirmed.continuationId]: 'structure_changed' } })
    await bare.env.seedHolds(bare.scope, [], { suspended: false })
    assert.equal(bare.continuations()[0].status, 'needs_reconfirmation')
    assert.equal(bare.holds().filter((row) => row.status === 'open').length, 0)
    const res = await end(bare, confirmed.continuationId, { revision: 1, outcome: 'escalate_special_repair' })
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).details.reason, 'no_open_hold')
  } finally { bare.restore() }
})

test('RT-E5 THE RELEASE FACTS UNDER THE LOCK (review B1 / P8 / P11): a computation lands between the end\'s consult and its transaction — (a) it records N(c)=1: 409 new_position_present from the open row under the lock; (b) it keeps N(c)=0 but recomputes the hold (another fingerprint): 409 CONFIRM_STALE facts_moved (the release binds to the hold the puller was shown); the body\'s own binding likewise; the relationship stays needs_reconfirmation, no bump, no audit row', async () => {
  const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
  for (const [label, nextCount, extraDetail, bodyBinds, expectedCode, expectedReason] of [
    ['N(c) 0 -> 1', 1, {}, false, CODES.END_OUTCOME_NOT_ADMISSIBLE, 'new_position_present'],
    ['N(c) 0 -> 0 recomputed', 0, { recomputed: true }, false, CODES.CONFIRM_STALE, 'facts_moved'],
    ['N(c) 0 -> 1, body binds', 1, {}, true, CODES.END_OUTCOME_NOT_ADMISSIBLE, 'new_position_present'],
    ['N(c) 0 -> 0 recomputed, body binds', 0, { recomputed: true }, true, CODES.CONFIRM_STALE, 'facts_moved'],
  ]) {
    const st = mount()
    try {
      const { confirmed, hold } = await needsReconfirmation(st, { count: 0 })
      const id = confirmed.continuationId
      const shown = st.holds().find((row) => row.status === 'open' && row.continuation_id === id)
      const lock0 = JSON.stringify(st.lockRow())
      let interleaved = null
      const release = pauseBeforeTransaction(st, 'continuation', id, async () => {
        const fresh = refreshKit.reconfirmHoldFor(id, { confirmable: false, verdict: 'new_position_removed' })
        fresh.detail = { ...fresh.detail, componentNewPositionCount: nextCount, ...extraDetail }
        fresh.fingerprint = pairing.holdFingerprint(fresh)
        await st.env.seedHolds(st.scope, [fresh], { verdicts: { [id]: 'new_position_removed' } })
        interleaved = { open: st.holds().filter((row) => row.status === 'open' && row.continuation_id === id).map((row) => ({ id: row.id, count: row.detail.componentNewPositionCount })), shownNow: st.holds().find((row) => row.id === shown.id).status, snapshot: st.env.snapshot() }
        st.env.db.log.length = 0
      })
      const res = await end(st, id, { revision: 1, outcome: 'release_to_normal_refresh', ...(bodyBinds ? { factsHoldId: shown.id, factsHoldFingerprint: hold.fingerprint } : {}) })
      assert.equal(release(), true, `${label}: the pause fired once`)
      assert.equal(interleaved.open.length, 1, label)
      assert.notEqual(interleaved.open[0].id, shown.id, `${label}: the computation opened another hold`)
      assert.equal(interleaved.shownNow, 'superseded', label)
      assert.equal(res.statusCode, 409, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(errorOf(res).code, expectedCode, label)
      assert.equal(errorOf(res).details.reason, expectedReason, label)
      if (expectedReason === 'new_position_present') assert.equal(errorOf(res).details.componentNewPositionCount, 1, label)
      assert.equal(stateRowTaken(st), true, `${label}: decided under the lock — the consult saw N(c)=0 on the hold the page showed`)
      assert.equal(st.env.snapshot(), interleaved.snapshot, `${label}: nothing persisted`)
      assert.equal(st.continuations()[0].status, 'needs_reconfirmation', label)
      assert.equal(st.continuations()[0].claim_active, true, label)
      assert.ok(st.members().every((member) => member.claim_active === true), `${label}: the old rows keep their protection`)
      assert.equal(JSON.stringify(st.lockRow()), lock0, `${label}: no bump`)
      assert.equal(st.audits().filter((entry) => entry.mode === REFRESH_DECISION_AUDIT.modes.ended).length, 0, label)
    } finally { st.restore() }
  }
})

test('RT-E6 S25 UNDER THE LOCK for a release (review N2 / P12): relationship A is escalated between B\'s consult and B\'s release transaction; the store refuses 409 END_OUTCOME_NOT_ADMISSIBLE runbook_only_hold_open under the lock, B stays needs_reconfirmation', async () => {
  const st = mount()
  try {
    const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
    const fixture = await refreshKit.candidateHoldFixture()
    const a = await st.env.seedConfirmedContinuation(st.scope, fixture.hold, { sourceIdentity: fixture.sourceIdentity })
    const b = await st.env.seedConfirmedContinuation(st.scope, refreshKit.disjointCandidateHold(fixture.hold), { sourceIdentity: fixture.sourceIdentity })
    const holdA = refreshKit.reconfirmHoldFor(a.continuationId, { confirmable: false, verdict: 'source_scope_changed' })
    const holdB = refreshKit.reconfirmHoldFor(b.continuationId, { confirmable: false, verdict: 'new_position_removed' })
    holdB.detail = { ...holdB.detail, componentNewPositionCount: 0 }
    holdB.fingerprint = pairing.holdFingerprint(holdB)
    await st.env.seedHolds(st.scope, [holdA, holdB], { verdicts: { [a.continuationId]: 'source_scope_changed', [b.continuationId]: 'new_position_removed' } })
    let interleaved = null
    const release = pauseBeforeTransaction(st, 'continuation', b.continuationId, async () => {
      await st.env.store.endContinuation({ ...st.scope, continuationId: a.continuationId, revision: 1, outcome: 'escalate_special_repair', endedBy: 'u_rd_other' }, { bumpWithin: (trx, key, options) => st.env.lock().bumpGenerationWithin(trx, key, options) })
      interleaved = { runbookOpen: st.holds().filter((row) => row.status === 'open' && row.runbook_only === true).length, snapshot: st.env.snapshot(), lock: JSON.stringify(st.lockRow()) }
      st.env.db.log.length = 0
    })
    const res = await end(st, b.continuationId, { revision: 1, outcome: 'release_to_normal_refresh' })
    assert.equal(release(), true, 'the pause fired once')
    assert.equal(interleaved.runbookOpen, 1)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, CODES.END_OUTCOME_NOT_ADMISSIBLE)
    assert.deepEqual(errorOf(res).details, { reason: 'runbook_only_hold_open', outcome: 'release_to_normal_refresh', holdCount: 1, partial: false })
    assert.equal(stateRowTaken(st), true, 'decided under the lock — the consult saw no runbook-only hold')
    assert.equal(st.env.snapshot(), interleaved.snapshot, 'nothing persisted')
    assert.equal(JSON.stringify(st.lockRow()), interleaved.lock, 'no bump')
    assert.equal(st.continuations().find((row) => row.id === b.continuationId).status, 'needs_reconfirmation')
    // The control: with the runbook hold closed by the owner's runbook (no store method writes it), the same release commits.
    for (const row of st.env.db.tables.get(REFRESH_STORE_TABLES.hold).values()) {
      if (row.status === 'open' && row.runbook_only === true) { row.status = 'resolved'; row.resolution = 'runbook_closed' }
    }
    const done = await end(st, b.continuationId, { revision: 1, outcome: 'release_to_normal_refresh' })
    assert.equal(done.statusCode, 200, JSON.stringify(done.body))
  } finally { st.restore() }
})

test('RT-E7 the body names the hold the page showed (factsHoldId + factsHoldFingerprint, review B1): the open hold named with its fingerprint => 200; another id or another fingerprint => 409 CONFIRM_STALE facts_moved (facts admissible, the row not the one shown), nothing persisted', async () => {
  const st = mount()
  try {
    const { confirmed, hold } = await needsReconfirmation(st, { count: 0 })
    const id = confirmed.continuationId
    const shown = st.holds().find((row) => row.status === 'open' && row.continuation_id === id)
    const before = st.env.snapshot()
    for (const [label, facts] of [
      ['another id', { factsHoldId: 'hold_rd_elsewhere', factsHoldFingerprint: hold.fingerprint }],
      ['another fingerprint', { factsHoldId: shown.id, factsHoldFingerprint: 'g'.repeat(64) }],
    ]) {
      const res = await end(st, id, { revision: 1, outcome: 'release_to_normal_refresh', ...facts })
      assert.equal(res.statusCode, 409, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(errorOf(res).code, CODES.CONFIRM_STALE, label)
      assert.equal(errorOf(res).details.reason, 'facts_moved', label)
      assert.equal(st.env.snapshot(), before, `${label}: nothing persisted`)
    }
    const done = await end(st, id, { revision: 1, outcome: 'release_to_normal_refresh', factsHoldId: shown.id, factsHoldFingerprint: hold.fingerprint })
    assert.equal(done.statusCode, 200, JSON.stringify(done.body))
    assert.equal(done.body.data.endedOutcome, 'release_to_normal_refresh')
    assert.equal(st.holds().find((row) => row.id === shown.id).resolution, 'continuation_ended')
  } finally { st.restore() }
})

// Step-4 review follow-ups (item 8, #6565 delta N-2): a release decides only from the relationship's OWN open
// relationship_reconfirm row. A needs re-confirmation by its verdict with NO open row; B (disjoint) has an
// admissible one (count 0). Ending A as a release while naming B's row is 409 no_open_hold — byte-identical to
// naming an unknown id (no oracle) — and nothing moves.
test('RT-E8 a release of A naming ANOTHER relationship\'s admissible reconfirm row is 409 END_OUTCOME_NOT_ADMISSIBLE no_open_hold, byte-identical to an unknown id; A stays needs_reconfirmation with its claims; no audit row, no bump, nothing persisted', async () => {
  const st = mount()
  try {
    const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
    const fixture = await refreshKit.candidateHoldFixture()
    const a = await st.env.seedConfirmedContinuation(st.scope, fixture.hold, { sourceIdentity: fixture.sourceIdentity })
    const b = await st.env.seedConfirmedContinuation(st.scope, refreshKit.disjointCandidateHold(fixture.hold), { sourceIdentity: fixture.sourceIdentity })
    const holdB = refreshKit.reconfirmHoldFor(b.continuationId, { confirmable: false, verdict: 'new_position_removed' })
    holdB.detail = { ...holdB.detail, componentNewPositionCount: 0 }
    holdB.fingerprint = pairing.holdFingerprint(holdB)
    await st.env.seedHolds(st.scope, [holdB], { verdicts: { [a.continuationId]: 'new_position_removed', [b.continuationId]: 'new_position_removed' } })
    assert.equal(st.continuations().find((row) => row.id === a.continuationId).status, 'needs_reconfirmation')
    assert.equal(st.holds().filter((row) => row.status === 'open' && row.continuation_id === a.continuationId).length, 0, 'A has no open row of its own')
    const rowB = st.holds().find((row) => row.status === 'open' && row.continuation_id === b.continuationId)
    const before = st.env.snapshot()
    const lock0 = JSON.stringify(st.lockRow())
    const audits0 = st.audits().length
    const namingB = await end(st, a.continuationId, { revision: 1, outcome: 'release_to_normal_refresh', factsHoldId: rowB.id, factsHoldFingerprint: rowB.fingerprint })
    const namingUnknown = await end(st, a.continuationId, { revision: 1, outcome: 'release_to_normal_refresh', factsHoldId: 'hold_rd_e8_unknown', factsHoldFingerprint: 'f'.repeat(64) })
    assert.equal(namingB.statusCode, 409, JSON.stringify(namingB.body))
    assert.equal(errorOf(namingB).code, CODES.END_OUTCOME_NOT_ADMISSIBLE)
    assert.equal(errorOf(namingB).details.reason, 'no_open_hold')
    assert.equal(JSON.stringify(namingB.body), JSON.stringify(namingUnknown.body), 'no oracle: another relationship\'s row answers as an unknown id')
    const rowA = st.continuations().find((row) => row.id === a.continuationId)
    assert.equal(rowA.status, 'needs_reconfirmation')
    assert.equal(rowA.claim_active, true)
    assert.equal(st.audits().length, audits0, 'no audit row')
    assert.equal(st.audits().some((item) => item.mode === REFRESH_DECISION_AUDIT.modes.ended), false)
    assert.equal(JSON.stringify(st.lockRow()), lock0, 'no bump')
    assert.equal(st.env.snapshot(), before, 'nothing persisted')
  } finally { st.restore() }
})

// ── RT-K: 「暂不处理」 ─────────────────────────────────────────────────────────────────────────────

test('RT-K1 keep: 200 { kept: true, holdId }, ONE audit row (exception_resolve / continuation_hold_kept), every step-4 row and the lock row unchanged; a moved fingerprint is STALE; a resolved hold is STALE hold_not_open', async () => {
  const st = mount()
  try {
    const { hold, row } = await seedCandidate(st)
    const before = st.env.snapshot()
    const lock0 = JSON.stringify(st.lockRow())
    const res = await keep(st, row.id, { holdFingerprint: hold.fingerprint })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.data, { kept: true, holdId: row.id })
    assert.equal(st.env.snapshot(), before)
    assert.equal(JSON.stringify(st.lockRow()), lock0)
    const audits = st.audits().filter((item) => item.mode === REFRESH_DECISION_AUDIT.modes.kept)
    assert.equal(audits.length, 1)
    assert.equal(audits[0].subjectId, row.id)
    assert.deepEqual(audits[0].detail, { operation: 'continuation_hold_kept', kind: 'continuation_candidate', confirmable: true, runbookOnly: false, tenantClaimVerified: false })
    const moved = await keep(st, row.id, { holdFingerprint: 'moved' })
    assert.equal(errorOf(moved).code, CODES.CONFIRM_STALE)
    assert.equal(errorOf(moved).details.reason, 'hold_fingerprint')
    const { body } = await readAndBind(st, row, hold)
    assert.equal((await confirm(st, body)).statusCode, 201)
    const resolved = await keep(st, row.id)
    assert.equal(errorOf(resolved).code, CODES.CONFIRM_STALE)
    assert.equal(errorOf(resolved).details.reason, 'hold_not_open')
  } finally { st.restore() }
})

// ── RT-EV / RT-D: the evidence and the detail ────────────────────────────────────────────────────

test('RT-EV the evidence behind a hold: the demand facts the computation recorded (old root / new parent, completeness, classification), history_unknown before any relationship; after the confirm the resolved hold\'s evidence names the relationship snapshot; the continuation detail lists header, members and the holds naming it', async () => {
  const st = mount()
  try {
    const { hold, row } = await seedCandidate(st)
    const ev = dataOf(await evidence(st, row.id))
    assert.equal(ev.kind, 'continuation_candidate')
    assert.deepEqual(ev.current.observations.map((entry) => entry.role), ['old_root', 'new_parent'])
    assert.equal(ev.current.completeness.status, 'complete')
    assert.equal(ev.current.classification, 'base_dropped')
    assert.equal(ev.history.status, 'history_unknown')
    assert.equal(ev.next, null)
    const cursor = await evidence(st, row.id, { query: { cursor: '1' } })
    assert.equal(cursor.statusCode, 400)
    const { body } = await readAndBind(st, row, hold)
    const done = dataOf(await confirm(st, body))
    const after = dataOf(await evidence(st, row.id))
    assert.equal(after.status, 'resolved')
    assert.equal(after.history.status, 'relationship_snapshot')
    assert.equal(after.history.continuationId, done.continuationId)
    assert.equal(after.history.continuationStatus, 'active')
    assert.deepEqual(after.history.observations.map((entry) => entry.role), ['old_root', 'new_parent'])
    const d = dataOf(await detail(st, done.continuationId))
    assert.equal(d.continuation.id, done.continuationId)
    assert.equal(d.continuation.status, 'active')
    assert.equal(d.members.length, 4)
    assert.deepEqual(d.members.map((member) => member.position), [0, 1, 2, 3])
    assert.ok(d.continuation.evidenceSnapshot && d.continuation.evidenceSnapshot.pairs.length === 4)
    assert.deepEqual(d.holds, [], 'the resolved hold names no relationship')
    const reads = st.audits().filter((item) => item.action === REFRESH_DECISION_AUDIT.readAction).map((item) => item.mode)
    assert.deepEqual(reads, ['refresh_evidence_read', 'refresh_hold_read', 'refresh_evidence_read', 'continuation_read'])
    assert.deepEqual(st.audits().find((item) => item.mode === 'continuation_read').detail, { operation: 'continuation_read', status: 'active', revision: 1, memberCount: 4, openHoldCount: 0, tenantClaimVerified: false })
  } finally { st.restore() }
})

// ── RT-NG ────────────────────────────────────────────────────────────────────────────────────────

test('RT-NG a registered project that is NOT governed: the hold page answers not_governed with no holds and NO receipt (nothing to confirm; a receipt is a plugin_kv row that is never swept — PR-4 review N4), the read is still audited, and no step-4 row is written by any read; the build marker stays 0 (pilot enable impossible — the pilot column is seeded directly by these cases)', async () => {
  assert.equal(CONTINUATION_SUPPORT_VERSION, 0)
  const st = mount({ pilot: false })
  try {
    const page = dataOf(await listHolds(st))
    assert.equal(page.refresh.status, 'not_governed')
    assert.equal(page.refresh.governed, 'none')
    assert.deepEqual(page.page.holds, [])
    assert.equal(page.holdSetFingerprint, null)
    assert.equal(page.readReceipt, null, 'no receipt for a project with nothing to confirm')
    assert.deepEqual(st.receipts(), [], 'no receipt stored')
    await evidence(st, 'hold_rd_absent')
    await detail(st, 'cont_rd_absent')
    assert.equal(st.env.stepFourRowCount(), 0, 'reads never write')
    assert.equal(st.audits().length, 1, 'the empty page is still an audited read')
    assert.equal(st.audits()[0].mode, REFRESH_DECISION_AUDIT.modes.holdRead)
  } finally { st.restore() }
})

// ── RT-RP: S1 — the confirm under the online read-plan switch ──────────────────────────────────────────
// The confirm route alone resolves the EFFECTIVE action of the hint-less lanes (reconcile, mvp-persist, the scheduled
// pull) while MULTITABLE_STOCK_PREP_ONLINE_READ_PLANS_ENABLED is 'true'. A spy ledger stands in for the read-plan
// store (the routes read `services.stockPreparationReadPlanStore` at call time); its pointer exists only at the
// tenant scope (workspace null), the only scope the management routes activate. The switch is set per mount and
// restored by `restore()` (the harness restores only its own keys). Every switch-ON call carries the verified claim:
// this suite's principals are claimless by default.

const RP_SYSTEM = 'plm_sql_source_synthetic' // the harness deployment's own source (project-sheet harness config)
const RP_WORKSPACE = 'ws_rd_hint'
const CLAIMED = Object.freeze({ authenticatedTenantId: TENANT })

// The ledger's canonical JSON + sha256 content key (stock-preparation-read-plan-store.cjs): a version whose key does
// not match its content is refused by the composition, so a wrong recipe here fails every switch-ON case loudly.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

// One approved, activated online plan for (TENANT, workspace null) naming the deployment's source, as the runtime read
// answers it: { activation, version, sourceValidation } (UUID revisions, read-plan-runtime.cjs).
function onlinePlanFixture() {
  const config = validateStockPreparationReadPlanConfig({
    schemaVersion: 1,
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    systemId: RP_SYSTEM,
    readPlan: {
      id: 'plm.stock-preparation.bom-read.user-draft.v1', sourceKind: 'data-source:sql-readonly', matchField: 'project', maxReadCount: 100,
      pathExAttr: { object: 'SYN_RD_PathLink', matchField: 'project', pathIdField: 'path' },
      pathInfo: { object: 'SYN_RD_Path', idField: 'id' },
      orderHead: { object: 'SYN_RD_Order', idField: 'id', pathIdField: 'path' },
      orderDetail: { object: 'SYN_RD_OrderLine', orderIdField: 'order', componentIdField: 'part', quantityField: 'qty' },
      part: { object: 'SYN_RD_Part', idField: 'id', codeField: 'code', nameField: 'name' },
      bomHead: { object: 'SYN_RD_Bom', parentPartField: 'part', bomIdField: 'id' },
      bomDetail: { object: 'SYN_RD_BomLine', bomParentField: 'bom', componentIdField: 'part', quantityField: 'qty' },
    },
  })
  const contentKey = crypto.createHash('sha256').update(canonicalJson(config)).digest('hex')
  const version = { id: 'rpv_rd_1', tenantId: TENANT, workspaceId: null, actionId: PLM_STOCK_PREPARATION_ACTION_ID, systemId: RP_SYSTEM, schemaVersion: 1, version: 1, status: 'approved', config, contentKey }
  const activation = { id: 'rpa_rd_1', tenantId: TENANT, workspaceId: null, actionId: PLM_STOCK_PREPARATION_ACTION_ID, systemId: RP_SYSTEM, versionId: version.id, contentKey, generation: 1, status: 'active', validationId: 'rpval_rd_1' }
  const sourceValidation = { connectionId: 'conn_rd_synthetic', connectionRevision: '22222222-2222-4222-8222-222222222222', bindingRevision: '11111111-1111-4111-8111-111111111111' }
  return Object.freeze({ activation, version, sourceValidation })
}

// The spy ledger. Every runtime read is counted; a pointer exists only at workspace null. `mode`: 'active' answers
// the plan, 'none' has no pointer (null), 'disabled' refuses 409 READ_PLAN_ACTIVATION_DISABLED as the real store
// does, 'throw' fails with a plain error (an outage).
function spyReadPlanStore(plan, mode) {
  const spy = {
    mode,
    calls: [],
    async getActivation() { return null },
    async getActiveForRuntime(input) {
      spy.calls.push({ ...input })
      if (input.workspaceId !== null || spy.mode === 'none') return null
      if (spy.mode === 'disabled') throw new StockPreparationReadPlanStoreError(409, 'READ_PLAN_ACTIVATION_DISABLED')
      if (spy.mode === 'throw') throw new Error('synthetic read-plan store outage rd-7c1e')
      return { activation: { ...plan.activation }, version: { ...plan.version, config: JSON.parse(JSON.stringify(plan.version.config)) }, sourceValidation: { ...plan.sourceValidation } }
    },
  }
  return spy
}

// mount()'s stack (the real store, reader and lock over one db, the registered pilot project) with the switch set
// (`online`) or unset, the spy ledger patched on, and optionally a source-binding store.
function mountOnline({ online = true, mode = 'active', sourceBindingStore = null } = {}) {
  const previous = process.env[ONLINE_READ_PLANS_ENABLED_ENV]
  const restoreSwitch = () => {
    if (previous === undefined) delete process.env[ONLINE_READ_PLANS_ENABLED_ENV]
    else process.env[ONLINE_READ_PLANS_ENABLED_ENV] = previous
  }
  if (online) process.env[ONLINE_READ_PLANS_ENABLED_ENV] = 'true'
  else delete process.env[ONLINE_READ_PLANS_ENABLED_ENV]
  let h
  try {
    h = harness.mountProjectSheetRoutes({
      tenantId: TENANT,
      projectNo: PROJECT,
      switchOn: true,
      refreshOptions: { lockOnRefreshDb: true },
      ...(sourceBindingStore ? { sourceBindingStore } : {}),
      serviceExtras: {
        stockPreparationConfirmationDecisionLease: { async acquire() { return { leaseId: 'lease_rd' } }, async release() { return true }, async renew() { return true } },
      },
    })
  } catch (error) {
    restoreSwitch()
    throw error
  }
  const registered = h.seedRegistryRow(PROJECT)
  markPilot(h)
  const plan = onlinePlanFixture()
  const spy = spyReadPlanStore(plan, mode)
  h.services.stockPreparationReadPlanStore = spy
  const env = h.refresh
  const sheetId = registered.sheetId
  return {
    h,
    env,
    sheetId,
    plan,
    spy,
    scope: { tenantId: TENANT, sheetId, projectNo: PROJECT },
    lockRow: () => env.rows(PROJECT_WRITE_LOCK_TABLE).find((row) => row.scope_key === sheetWriteScopeKey(sheetId)) || null,
    holds: () => env.rows('hold'),
    continuations: () => env.rows('continuation'),
    members: () => env.rows('member'),
    state: () => env.rows('state')[0] || null,
    audits: () => h.auditAppends,
    restore: () => {
      try { h.restore() } finally { restoreSwitch() }
    },
  }
}

// The two source identities a confirm can stamp: the deployment action's, and the online plan composed onto it at
// the tenant scope (what the hint-less lanes execute). Calibrated: only the read-plan digest differs.
async function identitiesOf(st) {
  const deploymentAction = await createStockPreparationTableActionRegistry({ actions: st.h.context.config.stockPreparationTableActions }).getTableAction({ tenantId: TENANT })
  const onlineAction = composeStockPreparationReadPlanAction({ action: deploymentAction, scope: { tenantId: TENANT, workspaceId: null }, activation: st.plan.activation, version: st.plan.version })
  const deployment = refreshSourceIdentity({ action: deploymentAction, tenantId: TENANT })
  const online = refreshSourceIdentity({ action: onlineAction, tenantId: TENANT })
  assert.notEqual(online.readPlanDigest, deployment.readPlanDigest, 'calibration: the online plan is not the deployment plan')
  assert.equal(online.externalSystemId, deployment.externalSystemId, 'calibration: the composition keeps the source')
  assert.equal(online.sourceScopeDigest, deployment.sourceScopeDigest, 'calibration: the composition keeps the scope digest')
  return { deployment, online }
}

// readAndBind with the verified claim on every page read.
async function readAndBindClaimed(st, row, hold) {
  const first = dataOf(await listHolds(st, {}, CLAIMED))
  let receipt = first.readReceipt
  const entry = first.page.holds.find((item) => item.id === row.id)
  const pages = entry && entry.pairPage ? entry.pairPage.count : 1
  for (let index = 1; index < pages; index += 1) {
    receipt = dataOf(await listHolds(st, { holdId: row.id, pairCursor: index, receipt: receipt.id }, CLAIMED)).readReceipt
  }
  return {
    receipt,
    body: {
      holdId: row.id,
      holdFingerprint: hold.fingerprint,
      comparisonFingerprint: hold.comparisonFingerprint,
      evidenceFingerprint: hold.evidenceFingerprint,
      candidateId: hold.pairingFingerprint,
      readReceipt: receipt.id,
      basis: { kind: 'puller_confirmed_same_demand', note: 'synthetic basis' },
      acknowledge: { historyUnknown: true },
    },
  }
}

// A confirm refused by the context leaves every step-4 row, the lock row, decision_version and the trail as they were.
function persistedState(st) {
  return {
    rows: st.env.snapshot(),
    lock: JSON.stringify(st.lockRow()),
    decisionVersion: st.state() ? st.state().decision_version : null,
    decisionAudits: st.audits().filter((entry) => entry.action === REFRESH_DECISION_AUDIT.decisionAction).length,
  }
}

test('RT-RP1 (S1) switch ON, an active pointer, no binding store: the confirm stamps the EFFECTIVE read-plan digest the hint-less lanes execute (not the deployment one), the external system and scope digest unchanged; the hold page reads no pointer, the confirm exactly one, at the tenant scope', async () => {
  const st = mountOnline()
  try {
    const ids = await identitiesOf(st)
    const { hold, row } = await seedCandidate(st)
    const { body } = await readAndBindClaimed(st, row, hold)
    assert.equal(st.spy.calls.length, 0, 'the hold page reads no activation pointer')
    const done = await confirm(st, body, CLAIMED)
    assert.equal(done.statusCode, 201, JSON.stringify(done.body))
    const cont = st.continuations()[0]
    assert.equal(cont.read_plan_digest, ids.online.readPlanDigest, 'the effective plan of the hint-less lanes')
    assert.notEqual(cont.read_plan_digest, ids.deployment.readPlanDigest, 'not the deployment plan')
    assert.equal(cont.external_system_id, ids.deployment.externalSystemId)
    assert.equal(cont.source_scope_digest, ids.deployment.sourceScopeDigest)
    assert.equal(st.spy.calls.length, 1, 'the confirm read the pointer exactly once')
    assert.deepEqual(st.spy.calls[0], { tenantId: TENANT, workspaceId: null, actionId: PLM_STOCK_PREPARATION_ACTION_ID, systemId: RP_SYSTEM })
  } finally { st.restore() }
})

test('RT-RP2 (S1) switch ON, the re-confirm path: a relationship stamped with the DEPLOYMENT identity (the S1 victim) is re-confirmed through the same route — revision 2, and the UPDATE stamps the effective digest', async () => {
  const st = mountOnline()
  try {
    const ids = await identitiesOf(st)
    const fixture = await refreshKit.candidateHoldFixture()
    const confirmed = await st.env.seedConfirmedContinuation(st.scope, fixture.hold, { sourceIdentity: ids.deployment })
    assert.equal(st.continuations()[0].read_plan_digest, ids.deployment.readPlanDigest, 'seeded with the deployment identity')
    const reconfirm = refreshKit.reconfirmHoldFor(confirmed.continuationId, { verdict: 'source_scope_changed' })
    await st.env.seedHolds(st.scope, [reconfirm], { verdicts: { [confirmed.continuationId]: 'source_scope_changed' } })
    const row = st.holds().find((entry) => entry.fingerprint === reconfirm.fingerprint && entry.status === 'open')
    const page = dataOf(await listHolds(st, {}, CLAIMED))
    const done = await confirm(st, { holdId: row.id, holdFingerprint: reconfirm.fingerprint, comparisonFingerprint: reconfirm.comparisonFingerprint, evidenceFingerprint: reconfirm.evidenceFingerprint, continuation: { id: confirmed.continuationId, revision: 1 }, readReceipt: page.readReceipt.id, acknowledge: { historyUnknown: true } }, CLAIMED)
    assert.equal(done.statusCode, 201, JSON.stringify(done.body))
    assert.equal(done.body.data.revision, 2)
    const cont = st.continuations()[0]
    assert.equal(cont.status, 'active')
    assert.equal(cont.revision, 2)
    assert.equal(cont.read_plan_digest, ids.online.readPlanDigest, 'the re-confirm stamps the effective plan')
    assert.equal(cont.external_system_id, ids.online.externalSystemId)
    assert.equal(cont.source_scope_digest, ids.online.sourceScopeDigest)
    assert.equal(st.spy.calls.length, 1)
  } finally { st.restore() }
})

test('RT-RP3 (S1) switch UNSET (the spy would answer an active pointer): holds, evidence, keep, confirm, detail and end read NO pointer; the confirm answers 201 and stamps the DEPLOYMENT digest, exactly as today', async () => {
  const st = mountOnline({ online: false })
  try {
    const ids = await identitiesOf(st)
    const { hold, row } = await seedCandidate(st)
    assert.equal((await evidence(st, row.id, CLAIMED)).statusCode, 200)
    assert.equal((await keep(st, row.id, { holdFingerprint: hold.fingerprint }, CLAIMED)).statusCode, 200)
    const { body } = await readAndBindClaimed(st, row, hold)
    const done = await confirm(st, body, CLAIMED)
    assert.equal(done.statusCode, 201, JSON.stringify(done.body))
    const cont = st.continuations()[0]
    assert.equal(cont.read_plan_digest, ids.deployment.readPlanDigest, 'switch unset: the deployment plan, as today')
    assert.equal(cont.external_system_id, ids.deployment.externalSystemId)
    assert.equal(cont.source_scope_digest, ids.deployment.sourceScopeDigest)
    assert.equal((await detail(st, done.body.data.continuationId, CLAIMED)).statusCode, 200)
    const ended = await end(st, done.body.data.continuationId, { revision: 1, outcome: 'escalate_special_repair' }, CLAIMED)
    assert.equal(ended.statusCode, 409, JSON.stringify(ended.body))
    assert.equal(errorOf(ended).code, CODES.END_OUTCOME_NOT_ADMISSIBLE, 'an active relationship is not ended here (RT-E1)')
    assert.equal(errorOf(ended).details.reason, 'status')
    assert.deepEqual(st.spy.calls, [], 'switch unset: no route read the activation pointer')
  } finally { st.restore() }
})

test('RT-RP4 (S1) switch ON, a DISABLED pointer: the confirm is 409 READ_PLAN_ACTIVATION_DISABLED with nothing persisted (no continuation or member, the hold open, generation, decision_version and trail unchanged); holds, evidence, keep, detail and end answer as before and read no pointer', async () => {
  const st = mountOnline({ mode: 'disabled' })
  try {
    const { hold, row } = await seedCandidate(st)
    const { body } = await readAndBindClaimed(st, row, hold)
    await st.env.lock().bumpGeneration(sheetWriteScopeKey(st.sheetId), { reason: 'small_preview', tenantId: TENANT })
    const before = persistedState(st)
    const refused = await confirm(st, body, CLAIMED)
    assert.equal(refused.statusCode, 409, JSON.stringify(refused.body))
    assert.equal(errorOf(refused).code, 'READ_PLAN_ACTIVATION_DISABLED')
    assert.deepEqual(persistedState(st), before, 'nothing persisted')
    assert.equal(st.continuations().length, 0)
    assert.equal(st.members().length, 0)
    assert.equal(st.holds().find((entry) => entry.id === row.id).status, 'open')
    assert.equal(st.spy.calls.length, 1, 'only the confirm read the pointer')
    // The same state: the hold page, the evidence and 「暂不处理」 answer as before, without a pointer read.
    const page = dataOf(await listHolds(st, {}, CLAIMED))
    assert.equal(page.page.holds.length, 1)
    assert.equal((await evidence(st, row.id, CLAIMED)).statusCode, 200)
    const kept = await keep(st, row.id, { holdFingerprint: hold.fingerprint }, CLAIMED)
    assert.equal(kept.statusCode, 200, JSON.stringify(kept.body))
    assert.deepEqual(kept.body.data, { kept: true, holdId: row.id })
    assert.equal(st.spy.calls.length, 1, 'holds, evidence and keep read no pointer')
  } finally { st.restore() }
  // A relationship needing re-confirmation under the same disabled pointer: the detail and the escalation answer.
  const rc = mountOnline({ mode: 'disabled' })
  try {
    const { confirmed } = await needsReconfirmation(rc, { count: 1 })
    const read = await detail(rc, confirmed.continuationId, CLAIMED)
    assert.equal(read.statusCode, 200, JSON.stringify(read.body))
    assert.equal(read.body.data.continuation.status, 'needs_reconfirmation')
    const escalated = await end(rc, confirmed.continuationId, { revision: 1, outcome: 'escalate_special_repair' }, CLAIMED)
    assert.equal(escalated.statusCode, 200, JSON.stringify(escalated.body))
    assert.equal(escalated.body.data.holdsEscalated, 1)
    assert.deepEqual(rc.spy.calls, [], 'detail and end read no pointer')
  } finally { rc.restore() }
})

test('RT-RP5 (S1) switch ON: a read-plan store without the runtime read is 501 READ_PLAN_RUNTIME_UNAVAILABLE, a runtime read that fails is 503 READ_PLAN_RUNTIME_UNAVAILABLE (values-free); nothing persisted either way', async () => {
  for (const [label, prepare, status] of [
    ['no runtime read', (st) => { st.h.services.stockPreparationReadPlanStore = { async getActivation() { return null } } }, 501],
    ['the runtime read fails', (st) => { st.spy.mode = 'throw' }, 503],
  ]) {
    const st = mountOnline()
    try {
      const { hold, row } = await seedCandidate(st)
      const { body } = await readAndBindClaimed(st, row, hold)
      await st.env.lock().bumpGeneration(sheetWriteScopeKey(st.sheetId), { reason: 'small_preview', tenantId: TENANT })
      const before = persistedState(st)
      prepare(st)
      const res = await confirm(st, body, CLAIMED)
      assert.equal(res.statusCode, status, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(errorOf(res).code, 'READ_PLAN_RUNTIME_UNAVAILABLE', label)
      assert.equal(JSON.stringify(res.body).includes('rd-7c1e'), false, `${label}: the store's own text never leaves`)
      assert.deepEqual(persistedState(st), before, `${label}: nothing persisted`)
      assert.equal(st.continuations().length, 0, label)
      assert.equal(st.holds().find((entry) => entry.id === row.id).status, 'open', label)
    } finally { st.restore() }
  }
})

test('RT-RP6 (S1) switch ON, NO pointer (the runtime read answers null): the confirm answers 201 and stamps the deployment digest; the pointer was read once', async () => {
  const st = mountOnline({ mode: 'none' })
  try {
    const ids = await identitiesOf(st)
    const { hold, row } = await seedCandidate(st)
    const { body } = await readAndBindClaimed(st, row, hold)
    const done = await confirm(st, body, CLAIMED)
    assert.equal(done.statusCode, 201, JSON.stringify(done.body))
    assert.equal(st.continuations()[0].read_plan_digest, ids.deployment.readPlanDigest)
    assert.equal(st.spy.calls.length, 1)
  } finally { st.restore() }
})

test('RT-RP7 (S1) switch ON, an active pointer: the lanes\' verified-claim check — a claimless confirm is 403 TENANT_CLAIM_REQUIRED with nothing persisted; the same body with the claim is 201', async () => {
  const st = mountOnline()
  try {
    const ids = await identitiesOf(st)
    const { hold, row } = await seedCandidate(st)
    const { body } = await readAndBindClaimed(st, row, hold)
    await st.env.lock().bumpGeneration(sheetWriteScopeKey(st.sheetId), { reason: 'small_preview', tenantId: TENANT })
    const before = persistedState(st)
    const claimless = await confirm(st, body)
    assert.equal(claimless.statusCode, 403, JSON.stringify(claimless.body))
    assert.equal(errorOf(claimless).code, 'TENANT_CLAIM_REQUIRED')
    assert.deepEqual(persistedState(st), before, 'nothing persisted')
    assert.equal(st.continuations().length, 0)
    const claimed = await confirm(st, body, CLAIMED)
    assert.equal(claimed.statusCode, 201, JSON.stringify(claimed.body))
    assert.equal(st.continuations()[0].read_plan_digest, ids.online.readPlanDigest)
  } finally { st.restore() }
})

test('RT-RP8 (S1) switch ON, R4 bindings (a tenant row and a workspace row naming the same source), the pointer only at the tenant scope: a confirm carrying ?workspaceId still resolves the HINT-LESS binding and stamps the effective digest', async () => {
  const bindings = wiring.createSourceBindingStoreFake()
  bindings.seed({ tenantId: TENANT, actionId: PLM_STOCK_PREPARATION_ACTION_ID, workspaceId: null, externalSystemId: RP_SYSTEM })
  bindings.seed({ tenantId: TENANT, actionId: PLM_STOCK_PREPARATION_ACTION_ID, workspaceId: RP_WORKSPACE, externalSystemId: RP_SYSTEM })
  const listed = await bindings.listForAction({ tenantId: TENANT, actionId: PLM_STOCK_PREPARATION_ACTION_ID })
  assert.equal(listed.complete, true)
  assert.deepEqual(listed.bindings.map((binding) => binding.workspaceId), [null, RP_WORKSPACE], 'calibration: R4')
  assert.equal((await bindings.get({ tenantId: TENANT, actionId: PLM_STOCK_PREPARATION_ACTION_ID, workspaceId: RP_WORKSPACE })).matchedWorkspaceId, RP_WORKSPACE, 'calibration: the hint would bind the workspace row')
  const st = mountOnline({ sourceBindingStore: bindings })
  try {
    const ids = await identitiesOf(st)
    const { hold, row } = await seedCandidate(st)
    const { body } = await readAndBindClaimed(st, row, hold)
    const done = await confirm(st, body, { ...CLAIMED, query: { workspaceId: RP_WORKSPACE } })
    assert.equal(done.statusCode, 201, JSON.stringify(done.body))
    assert.equal(st.continuations()[0].read_plan_digest, ids.online.readPlanDigest, 'the hint-less (tenant) binding and its pointer')
    assert.deepEqual(st.spy.calls.map((call) => call.workspaceId), [null])
  } finally { st.restore() }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-refresh-decision-routes.test.cjs', tests)
