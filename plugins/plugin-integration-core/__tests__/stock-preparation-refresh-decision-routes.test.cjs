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
//   RT-C    the confirm: NOT_PILOT; RECOVERY_PENDING; S25 runbook-only hold open; STALE (fingerprint, candidate,
//           hold not open); NOT_ALLOWED (kind, not confirmable); WRITE_LOCKED while a lease is live, nothing
//           persisted, then 201 after release with the generation bumped IN the transaction (reason
//           continuation_confirm), the hold resolved, decision_version + 1 and the audit row on the handle
//   RT-E09  the audit append inside the transaction fails => 503, rollback: no continuation, generation
//           unchanged, hold still open
//   RT-RC   the re-confirm through the same route (relationship_reconfirm + { id, revision }) => revision 2
//   RT-E    the end: an ACTIVE relationship refused; release only with the recorded componentNewPositionCount 0
//           (1 => new_position_present, absent => facts_missing), never from the body; escalate keeps the hold
//           runbook-only; superseded_by_new_confirmation is confirm-only
//   RT-K    「暂不处理」: audit only, nothing persisted, STALE on a moved fingerprint
//   RT-EV   the evidence: the demand facts of the computation that opened the hold; history_unknown, then the
//           relationship snapshot once a relationship claims the old root; the continuation detail
//   RT-NG   a registered, NOT-governed project: not_governed, no holds, no step-4 row written by a read
// Synthetic values only; the pilot column is seeded directly (pilot enable is impossible on this build: the
// readiness marker CONTINUATION_SUPPORT_VERSION is 0).

const assert = require('node:assert/strict')
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
    const res = await confirm(st, body)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, CODES.RECOVERY_PENDING)
    assert.deepEqual(errorOf(res).details, { state: 'failed_pending_recovery', openExecutions: 1, partial: false })
    const ended = await end(st, 'cont_rd_absent', { revision: 1, outcome: 'escalate_special_repair' })
    assert.equal(errorOf(ended).code, CODES.RECOVERY_PENDING)
    assert.equal(st.env.snapshot(), before)
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

test('RT-C3 (S25) an OPEN runbook-only hold (an escalated relationship): the confirm of another candidate is 409 NOT_ALLOWED runbook_only_hold_open and a release is 409 END_OUTCOME_NOT_ADMISSIBLE runbook_only_hold_open; 「暂不处理」 and an escalation stay allowed', async () => {
  const st = mount()
  try {
    const fixture = await refreshKit.candidateHoldFixture()
    const escalated = await st.env.seedEscalatedContinuation(st.scope, fixture.hold, { sourceIdentity: fixture.sourceIdentity })
    assert.ok(st.holds().some((row) => row.status === 'open' && row.runbook_only === true), 'the escalated hold is open, runbook-only')
    // Another, disjoint candidate (other old rows, other new position) is open beside it.
    const other = refreshKit.disjointCandidateHold(fixture.hold)
    await st.env.seedHolds(st.scope, [other], { verdicts: {} })
    const otherRow = st.holds().find((row) => row.fingerprint === other.fingerprint && row.status === 'open')
    assert.ok(otherRow)
    const { body } = await readAndBind(st, otherRow, other)
    const before = st.env.snapshot()
    const res = await confirm(st, body)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, CODES.CONFIRM_NOT_ALLOWED)
    assert.deepEqual(errorOf(res).details, { reason: 'runbook_only_hold_open', holdCount: 1, partial: false })
    const kept = await keep(st, otherRow.id)
    assert.equal(kept.statusCode, 200, JSON.stringify(kept.body))
    // A second relationship that needs reconfirmation: release refused by S25, escalate admitted.
    const secondHold = refreshKit.disjointCandidateHold(fixture.hold, { parentId: 'Y-001', suffix: '_rd2' })
    const second = await st.env.seedConfirmedContinuation(st.scope, secondHold, { sourceIdentity: fixture.sourceIdentity })
    await st.env.seedHolds(st.scope, [refreshKit.reconfirmHoldFor(second.continuationId, { verdict: 'new_position_removed' })], { verdicts: { [second.continuationId]: 'new_position_removed' } })
    const release = await end(st, second.continuationId, { revision: 1, outcome: 'release_to_normal_refresh' })
    assert.equal(release.statusCode, 409, JSON.stringify(release.body))
    assert.equal(errorOf(release).code, CODES.END_OUTCOME_NOT_ADMISSIBLE)
    assert.equal(errorOf(release).details.reason, 'runbook_only_hold_open')
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
      const res = await end(st, confirmed.continuationId, { revision: 1, outcome: 'release_to_normal_refresh', note: 'release' })
      assert.equal(res.statusCode, expected.status, `${label}: ${JSON.stringify(res.body)}`)
      if (expected.status === 409) {
        assert.equal(errorOf(res).code, CODES.END_OUTCOME_NOT_ADMISSIBLE, label)
        assert.equal(errorOf(res).details.reason, expected.reason, label)
        assert.equal(errorOf(res).details.outcome, 'release_to_normal_refresh', label)
        assert.equal(st.env.snapshot(), before, `${label}: nothing persisted`)
        assert.equal(st.continuations()[0].status, 'needs_reconfirmation', label)
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

test('RT-NG a registered project that is NOT governed: the hold page answers not_governed with no holds, a receipt is still issued, and no step-4 row is written by any read; the build marker stays 0 (pilot enable impossible — the pilot column is seeded directly by these cases)', async () => {
  assert.equal(CONTINUATION_SUPPORT_VERSION, 0)
  const st = mount({ pilot: false })
  try {
    const page = dataOf(await listHolds(st))
    assert.equal(page.refresh.status, 'not_governed')
    assert.equal(page.refresh.governed, 'none')
    assert.deepEqual(page.page.holds, [])
    assert.equal(page.holdSetFingerprint, null)
    assert.match(page.readReceipt.id, /^[0-9a-f]{32}$/)
    await evidence(st, 'hold_rd_absent')
    await detail(st, 'cont_rd_absent')
    assert.equal(st.env.stepFourRowCount(), 0, 'reads never write')
    assert.equal(st.audits().length, 1, 'the empty page is still an audited read')
  } finally { st.restore() }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-refresh-decision-routes.test.cjs', tests)
