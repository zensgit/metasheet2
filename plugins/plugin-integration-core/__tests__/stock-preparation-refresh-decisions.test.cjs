'use strict'

// Batch-refresh step 4, PR-4 — THE DECISION LIBRARY on its own (lib/stock-preparation-refresh-decisions.cjs): the
// read receipt store over a fake plugin storage, the hold payload projection and its pair paging, the body
// normalizers and the by-id read translation. The routes and the transactions are driven by
// stock-preparation-refresh-decision-routes.test.cjs; this suite pins the pure pieces one by one.
//
//   RD-R1  the receipt: a fresh id per actor + scope; pages accumulate; a hold whose fingerprints moved starts over;
//          an unknown / expired / foreign (actor or scope) receipt id starts a FRESH receipt on a read
//   RD-R2  verify: strict on every point — absent, scope, actor, expired, hold not seen, fingerprint moved, pages
//          missing — and ok only with every pair page served and the current fingerprints
//   RD-R3  the receipt key prefix never collides with the large-BOM prefix the readiness scan reads; the record is
//          values-free (ids, digests, counts, timestamps)
//   RD-R4  a receipt write that throws leaves the stored receipt unchanged over a live-reference storage (load
//          clones; step-4 review follow-ups, item 7)
//   RD-R5  (step 5 PR-8) a page index outside the hold's page count is never recorded, so the public flag and verify
//          agree (the change-plan page pages on past a written plan's last page)
//   RD-P1  the hold payload: a candidate's pairs and comparison items paged together; a relationship hold's
//          verification incl. componentNewPositionCount; a content change; other kinds pass their detail; a page
//          past the end is 400
//   RD-B1  the confirm / end body normalizers: field-by-field 400s, no silent defaults
//   RD-T1  translateByIdRead: a foreign-tenant row and another scope's row become the SAME 404; other store errors pass
//   RD-CP1 step 5 PR-8: the change-plan legs refuse a half-wired context by name (501) before any read — the page
//          without receipts / plan reads / the sheet reader; the confirm without the plan transaction / receipts; the
//          review without the in-transaction audit / receipts / the live-writer check / the sheet reader
//   RD-CP2 the change-plan body normalizers: field-by-field 400s, trimmed ids and echoes, the combined candidates, the
//          review's optional notes — no silent defaults
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const refreshKit = require('./support/stock-preparation-refresh-store-kit.cjs')
const { consumableMap } = require('./support/consumable-storage.cjs')
const decisions = require(path.join(LIB, 'stock-preparation-refresh-decisions.cjs'))
const { StockPreparationRefreshStoreError, REFRESH_STORE_ERROR_CODES } = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
const { LARGE_BOM_CHECKPOINT_APPLY_KEY_PREFIX } = require(path.join(LIB, 'stock-preparation-large-bom-jobs.cjs')).__internals

const { createReadReceiptStore, READ_RECEIPT_KEY_PREFIX, READ_RECEIPT_TTL_MS, REFRESH_DECISION_ERROR_CODES: CODES } = decisions
const { holdPayload, normalizeConfirmBody, normalizeEndBody, translateByIdRead, normalizeChangePlanConfirmBody, normalizeReviewBody } = decisions.__internals

const tests = []
const test = (name, fn) => tests.push([name, fn])

const SCOPE = Object.freeze({ tenantId: 'tenant_rd', sheetId: 'sheet_rd', projectNo: 'PRJ-RD' })
const OTHER_SCOPE = Object.freeze({ tenantId: 'tenant_rd_other', sheetId: 'sheet_rd', projectNo: 'PRJ-RD' })

function receiptEnv() {
  const clock = refreshKit.createClock()
  const storage = consumableMap()
  let n = 0
  const receipts = createReadReceiptStore({ storage, now: clock.now, idGenerator: () => `${String((n += 1)).padStart(2, '0')}${'0'.repeat(30)}` })
  return { clock, storage, receipts }
}

const hold = (id, fp = 'h') => ({ id, fingerprint: `${fp}-fingerprint`, comparisonFingerprint: `${fp}-comparison`, evidenceFingerprint: `${fp}-evidence` })
const page = (h, pairPageIndex, pairPageCount) => ({ holdId: h.id, fingerprint: h.fingerprint, comparisonFingerprint: h.comparisonFingerprint, evidenceFingerprint: h.evidenceFingerprint, pairPageIndex, pairPageCount })

test('RD-R1 the receipt store: a fresh id; pages accumulate on the same id; moved fingerprints start the hold over; an unknown, foreign or expired id starts a FRESH receipt on a read', async () => {
  const { clock, storage, receipts } = receiptEnv()
  const a = hold('hold_a')
  const first = await receipts.record({ scope: SCOPE, actorId: 'u_a', pages: [page(a, 0, 3)] })
  assert.match(first.id, /^[0-9a-f]{32}$/)
  assert.deepEqual(first.holds, { hold_a: { pageCount: 3, pagesServed: [0], complete: false } })
  assert.equal(first.expiresAt, new Date(clock.ms() + READ_RECEIPT_TTL_MS).toISOString())
  const second = await receipts.record({ receiptId: first.id, scope: SCOPE, actorId: 'u_a', pages: [page(a, 2, 3)] })
  assert.equal(second.id, first.id)
  assert.deepEqual(second.holds.hold_a, { pageCount: 3, pagesServed: [0, 2], complete: false })
  const third = await receipts.record({ receiptId: first.id, scope: SCOPE, actorId: 'u_a', pages: [page(a, 1, 3)] })
  assert.deepEqual(third.holds.hold_a, { pageCount: 3, pagesServed: [0, 1, 2], complete: true })
  // The hold's fingerprints moved: its page set starts over (the new fingerprints are what the receipt now vouches for).
  const moved = await receipts.record({ receiptId: first.id, scope: SCOPE, actorId: 'u_a', pages: [page(hold('hold_a', 'h2'), 0, 3)] })
  assert.deepEqual(moved.holds.hold_a, { pageCount: 3, pagesServed: [0], complete: false })
  // Foreign actor / scope / unknown / expired => a fresh id, never an error on a read.
  const foreignActor = await receipts.record({ receiptId: first.id, scope: SCOPE, actorId: 'u_b', pages: [page(a, 0, 1)] })
  assert.notEqual(foreignActor.id, first.id)
  const foreignScope = await receipts.record({ receiptId: first.id, scope: OTHER_SCOPE, actorId: 'u_a', pages: [page(a, 0, 1)] })
  assert.notEqual(foreignScope.id, first.id)
  const unknown = await receipts.record({ receiptId: 'f'.repeat(32), scope: SCOPE, actorId: 'u_a', pages: [page(a, 0, 1)] })
  assert.notEqual(unknown.id, first.id)
  clock.advance(READ_RECEIPT_TTL_MS + 1)
  const expired = await receipts.record({ receiptId: first.id, scope: SCOPE, actorId: 'u_a', pages: [page(a, 0, 1)] })
  assert.notEqual(expired.id, first.id)
  assert.equal(storage.size, 5)
  // Values-free record: ids, digests, counts, timestamps.
  const stored = storage.get(`${READ_RECEIPT_KEY_PREFIX}${first.id}`)
  assert.deepEqual(Object.keys(stored).sort(), ['actorId', 'createdAt', 'expiresAt', 'holds', 'id', 'projectNo', 'sheetId', 'tenantId', 'v'])
  assert.deepEqual(Object.keys(stored.holds.hold_a).sort(), ['comparisonFingerprint', 'evidenceFingerprint', 'fingerprint', 'pairPageCount', 'pairPagesServed'])
  // No storage => 501 by name.
  const none = createReadReceiptStore({ storage: null })
  await assert.rejects(() => none.record({ scope: SCOPE, actorId: 'u_a', pages: [] }), (error) => error.status === 501 && error.code === CODES.RECEIPT_STORE_UNAVAILABLE)
})

test('RD-R2 verify is strict on every point and ok only with every pair page served under the current fingerprints', async () => {
  const { clock, receipts } = receiptEnv()
  const a = hold('hold_a')
  const current = { id: 'hold_a', fingerprint: a.fingerprint, comparisonFingerprint: a.comparisonFingerprint, evidenceFingerprint: a.evidenceFingerprint }
  assert.deepEqual(await receipts.verify({ receiptId: 'f'.repeat(32), scope: SCOPE, actorId: 'u_a', hold: current }), { ok: false, reason: 'receipt_absent', pagesServed: 0, pageCount: null })
  assert.deepEqual(await receipts.verify({ receiptId: 'not-an-id', scope: SCOPE, actorId: 'u_a', hold: current }), { ok: false, reason: 'receipt_absent', pagesServed: 0, pageCount: null })
  const one = await receipts.record({ scope: SCOPE, actorId: 'u_a', pages: [page(a, 0, 2)] })
  assert.deepEqual(await receipts.verify({ receiptId: one.id, scope: OTHER_SCOPE, actorId: 'u_a', hold: current }), { ok: false, reason: 'receipt_scope', pagesServed: 0, pageCount: null })
  assert.deepEqual(await receipts.verify({ receiptId: one.id, scope: SCOPE, actorId: 'u_b', hold: current }), { ok: false, reason: 'receipt_actor', pagesServed: 0, pageCount: null })
  assert.deepEqual(await receipts.verify({ receiptId: one.id, scope: SCOPE, actorId: 'u_a', hold: { ...current, id: 'hold_b' } }), { ok: false, reason: 'hold_not_in_receipt', pagesServed: 0, pageCount: null })
  assert.deepEqual(await receipts.verify({ receiptId: one.id, scope: SCOPE, actorId: 'u_a', hold: { ...current, evidenceFingerprint: 'moved' } }), { ok: false, reason: 'fingerprint_moved', pagesServed: 1, pageCount: 2 })
  // Each of the three fingerprints is its own leg (review note 7: the hold fingerprint's leg was unpinned).
  assert.deepEqual(await receipts.verify({ receiptId: one.id, scope: SCOPE, actorId: 'u_a', hold: { ...current, fingerprint: 'moved' } }), { ok: false, reason: 'fingerprint_moved', pagesServed: 1, pageCount: 2 })
  assert.deepEqual(await receipts.verify({ receiptId: one.id, scope: SCOPE, actorId: 'u_a', hold: { ...current, comparisonFingerprint: 'moved' } }), { ok: false, reason: 'fingerprint_moved', pagesServed: 1, pageCount: 2 })
  assert.deepEqual(await receipts.verify({ receiptId: one.id, scope: SCOPE, actorId: 'u_a', hold: current }), { ok: false, reason: 'pages_missing', pagesServed: 1, pageCount: 2 })
  await receipts.record({ receiptId: one.id, scope: SCOPE, actorId: 'u_a', pages: [page(a, 1, 2)] })
  assert.deepEqual(await receipts.verify({ receiptId: one.id, scope: SCOPE, actorId: 'u_a', hold: current }), { ok: true, pagesServed: 2, pageCount: 2 })
  clock.advance(READ_RECEIPT_TTL_MS)
  assert.deepEqual(await receipts.verify({ receiptId: one.id, scope: SCOPE, actorId: 'u_a', hold: current }), { ok: false, reason: 'receipt_expired', pagesServed: 0, pageCount: null })
})

test('RD-R3 the receipt key prefix is outside the large-BOM apply prefix the pilot readiness scan reads', () => {
  assert.equal(READ_RECEIPT_KEY_PREFIX.startsWith(LARGE_BOM_CHECKPOINT_APPLY_KEY_PREFIX), false)
  assert.equal(LARGE_BOM_CHECKPOINT_APPLY_KEY_PREFIX.startsWith(READ_RECEIPT_KEY_PREFIX), false)
  assert.equal(READ_RECEIPT_KEY_PREFIX, 'integration:stock-prep:refresh-read-receipt:')
})

// Step-4 review follow-ups (item 7, #6565 delta N-1): over a LIVE-REFERENCE storage (a memory-backed deployment, the
// kit's consumableMap) a `record` whose `set` throws must not leave the page on the stored receipt — `load` hands
// out a copy, so only a successful `set` changes what `verify` sees.
test('RD-R4 a receipt write that throws leaves the stored receipt unchanged (live-reference storage): verify still says pages_missing', async () => {
  const clock = refreshKit.createClock()
  const storage = consumableMap()
  const realSet = storage.set.bind(storage)
  let failNextSet = false
  storage.set = (key, value) => {
    if (failNextSet) { failNextSet = false; throw new Error('storage write failed') }
    return realSet(key, value)
  }
  const receipts = createReadReceiptStore({ storage, now: clock.now, idGenerator: () => 'a'.repeat(32) })
  const a = hold('hold_a')
  const current = { id: 'hold_a', fingerprint: a.fingerprint, comparisonFingerprint: a.comparisonFingerprint, evidenceFingerprint: a.evidenceFingerprint }
  const first = await receipts.record({ scope: SCOPE, actorId: 'u_a', pages: [page(a, 0, 2)] })
  failNextSet = true
  await assert.rejects(() => receipts.record({ receiptId: first.id, scope: SCOPE, actorId: 'u_a', pages: [page(a, 1, 2)] }), /storage write failed/)
  assert.deepEqual(await receipts.verify({ receiptId: first.id, scope: SCOPE, actorId: 'u_a', hold: current }), { ok: false, reason: 'pages_missing', pagesServed: 1, pageCount: 2 }, 'the unserved page is not vouched for')
  assert.deepEqual(storage.get(`${READ_RECEIPT_KEY_PREFIX}${first.id}`).holds.hold_a.pairPagesServed, [0], 'the stored record still lists page 0 only')
})

test('RD-R5 (step 5 PR-8) a page index outside the page count of the hold is never recorded: the receipt neither shows nor verifies it as served; an in-range page then completes it', async () => {
  const { receipts } = receiptEnv()
  const a = hold('hold_a')
  const current = { id: 'hold_a', fingerprint: a.fingerprint, comparisonFingerprint: a.comparisonFingerprint, evidenceFingerprint: a.evidenceFingerprint }
  const past = await receipts.record({ scope: SCOPE, actorId: 'u_a', pages: [page(a, 1, 1), page(a, -1, 1)] })
  assert.deepEqual(past.holds, {}, 'a page past the last one (or before the first) is not a served page')
  assert.deepEqual(await receipts.verify({ receiptId: past.id, scope: SCOPE, actorId: 'u_a', hold: current }), { ok: false, reason: 'hold_not_in_receipt', pagesServed: 0, pageCount: null })
  const served = await receipts.record({ receiptId: past.id, scope: SCOPE, actorId: 'u_a', pages: [page(a, 0, 1)] })
  assert.equal(served.id, past.id)
  assert.deepEqual(served.holds.hold_a, { pageCount: 1, pagesServed: [0], complete: true })
  assert.deepEqual(await receipts.verify({ receiptId: past.id, scope: SCOPE, actorId: 'u_a', hold: current }), { ok: true, pagesServed: 1, pageCount: 1 })
})

test('RD-P1 the hold payload: a candidate\'s pairs and comparison items are paged together (candidateId = the pairing fingerprint); a relationship hold carries its verification and componentNewPositionCount; a content change its fields; other kinds their detail; a page past the end is 400', async () => {
  const fixture = await refreshKit.candidateHoldFixture()
  const candidate = { ...fixture.hold, id: 'hold_c', status: 'open', runbookOnly: false, openedAt: '2026-10-24T00:00:00.000Z', lastSeenAt: '2026-10-24T00:00:00.000Z' }
  const full = holdPayload(candidate, { pairPageIndex: 0, pairLimit: 200 })
  assert.equal(full.kind, 'continuation_candidate')
  assert.equal(full.candidates.length, 1)
  assert.equal(full.candidates[0].candidateId, fixture.hold.pairingFingerprint)
  assert.equal(full.candidates[0].pairs.length, 4)
  assert.equal(full.candidates[0].comparison.items.length, 4)
  assert.deepEqual(full.pairPage, { index: 0, count: 1, size: 200, next: null })
  assert.equal(full.history, 'history_unknown')
  assert.deepEqual(full.verification, null)
  assert.deepEqual(full.contentChanges, [])
  assert.equal(full.detail, null)
  const paged = holdPayload(candidate, { pairPageIndex: 1, pairLimit: 3 })
  assert.deepEqual(paged.pairPage, { index: 1, count: 2, size: 3, next: null })
  assert.equal(paged.candidates[0].pairs.length, 1)
  assert.deepEqual(paged.candidates[0].comparison.items.map((item) => JSON.stringify(item.relativePath)), paged.candidates[0].pairs.map((pair) => JSON.stringify(pair.relativePath)), 'the items follow the page\'s pairs')
  assert.throws(() => holdPayload(candidate, { pairPageIndex: 2, pairLimit: 3 }), (error) => error.status === 400 && error.details.field === 'pairCursor')
  const reconfirm = { ...refreshKit.reconfirmHoldFor('cont_x', { verdict: 'new_position_removed' }), id: 'hold_r', status: 'open' }
  reconfirm.detail = { ...reconfirm.detail, componentNewPositionCount: 0 }
  const verification = holdPayload(reconfirm, { pairPageIndex: 0, pairLimit: 200 })
  assert.equal(verification.verification.verdict, 'new_position_removed')
  assert.equal(verification.verification.componentNewPositionCount, 0)
  assert.deepEqual(verification.candidates, [])
  const content = { id: 'hold_cc', kind: 'content_change', status: 'open', confirmable: false, notConfirmableReason: 'needs_step5', fingerprint: 'f', detail: { recordId: 'rec_1', recordVersion: 3, key: 'k', reason: 'plm_system_refresh', fields: { material: { before: 'M1', after: 'M2' } }, inContinuation: null, humanColumnsPresent: { notes: true } } }
  const change = holdPayload(content, { pairPageIndex: 0, pairLimit: 200 })
  assert.deepEqual(change.contentChanges, [{ recordId: 'rec_1', recordVersion: 3, key: 'k', reason: 'plm_system_refresh', fields: { material: { before: 'M1', after: 'M2' } }, inContinuation: null, humanColumnsPresent: { notes: true } }])
  const dropped = { id: 'hold_d', kind: 'dropped_order_head_unresolved', status: 'open', confirmable: false, notConfirmableReason: 'customer_rule_pending', fingerprint: 'g', detail: { componentSourceId: 'S-9', rules: ['dash_descendant'], history: 'history_unknown' } }
  assert.deepEqual(holdPayload(dropped, { pairPageIndex: 0, pairLimit: 200 }).detail, dropped.detail)
})

test('RD-B1 the confirm and end body normalizers refuse field by field (400, the field named) and never default a binding', () => {
  const good = { holdId: 'hold_1', holdFingerprint: 'a', comparisonFingerprint: 'b', evidenceFingerprint: 'c', candidateId: 'd', readReceipt: 'e'.repeat(32), basis: { kind: 'puller_confirmed_same_demand', note: 'n' }, acknowledge: { historyUnknown: true } }
  const out = normalizeConfirmBody(good)
  assert.deepEqual(out.echo, { holdFingerprint: 'a', comparisonFingerprint: 'b', evidenceFingerprint: 'c' })
  assert.equal(out.candidateId, 'd')
  assert.deepEqual(out.basis, { kind: 'puller_confirmed_same_demand', note: 'n' })
  assert.equal(out.continuation, null)
  for (const [label, mutate, field] of [
    ['not an object', () => 'x', 'body'],
    ['no holdId', (b) => { delete b.holdId }, 'holdId'],
    ['blank fingerprint', (b) => { b.holdFingerprint = ' ' }, 'holdFingerprint'],
    ['no receipt', (b) => { delete b.readReceipt }, 'readReceipt'],
    ['blank candidateId', (b) => { b.candidateId = '' }, 'candidateId'],
    ['continuation without revision', (b) => { b.continuation = { id: 'cont_1' } }, 'continuation'],
    ['basis kind', (b) => { b.basis = { kind: 'other' } }, 'basis.kind'],
    ['basis note type', (b) => { b.basis = { kind: 'puller_confirmed_same_demand', note: 7 } }, 'basis.note'],
    ['acknowledge type', (b) => { b.acknowledge = { historyUnknown: 'yes' } }, 'acknowledge'],
  ]) {
    const body = label === 'not an object' ? mutate() : (() => { const b = JSON.parse(JSON.stringify(good)); mutate(b); return b })()
    assert.throws(() => normalizeConfirmBody(body), (error) => error.status === 400 && error.code === CODES.REQUEST_INVALID && error.details.field === field, label)
  }
  assert.deepEqual(normalizeEndBody({ revision: 2, outcome: 'escalate_special_repair', note: 'why' }), { revision: 2, outcome: 'escalate_special_repair', note: 'why', facts: null })
  // PR-4 review B1: a release may name the hold the page showed (both keys, trimmed); never on another outcome.
  assert.deepEqual(normalizeEndBody({ revision: 1, outcome: 'release_to_normal_refresh', factsHoldId: ' hold_7 ', factsHoldFingerprint: 'f'.repeat(64) }), { revision: 1, outcome: 'release_to_normal_refresh', note: null, facts: { holdId: 'hold_7', holdFingerprint: 'f'.repeat(64) } })
  assert.deepEqual(normalizeEndBody({ revision: 1, outcome: 'release_to_normal_refresh' }).facts, null, 'without the keys the release binds to the consult (decisions.end)')
  for (const [body, field] of [
    [{ revision: 0, outcome: 'escalate_special_repair' }, 'revision'],
    [{ revision: 1, outcome: 'nope' }, 'outcome'],
    [{ revision: 1, outcome: 'escalate_special_repair', note: 1 }, 'note'],
    ['x', 'body'],
    [{ revision: 1, outcome: 'release_to_normal_refresh', factsHoldId: 'hold_7' }, 'factsHoldFingerprint'],
    [{ revision: 1, outcome: 'release_to_normal_refresh', factsHoldFingerprint: 'f'.repeat(64) }, 'factsHoldId'],
    [{ revision: 1, outcome: 'release_to_normal_refresh', factsHoldId: ' ', factsHoldFingerprint: 'f'.repeat(64) }, 'factsHoldId'],
    [{ revision: 1, outcome: 'release_to_normal_refresh', factsHoldId: 'hold_7', factsHoldFingerprint: 7 }, 'factsHoldFingerprint'],
    [{ revision: 1, outcome: 'escalate_special_repair', factsHoldId: 'hold_7', factsHoldFingerprint: 'f'.repeat(64) }, 'factsHoldId'],
  ]) {
    assert.throws(() => normalizeEndBody(body), (error) => error.status === 400 && error.details.field === field, JSON.stringify(body))
  }
})

test('RD-T1 translateByIdRead: a foreign-tenant row (TENANT_MISMATCH) and another scope\'s row (STALE *_scope) are the SAME not-found the caller names; a 503 and a non-scope STALE pass through', () => {
  const notFound = () => Object.assign(new Error('nf'), { status: 404, code: 'NF' })
  const mismatch = new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.TENANT_MISMATCH, 'x', { table: 'hold' })
  const scope = new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.CONFIRM_STALE, 'x', { reason: 'hold_scope' })
  assert.equal(translateByIdRead(mismatch, notFound).code, 'NF')
  assert.equal(translateByIdRead(scope, notFound).code, 'NF')
  const failed = new StockPreparationRefreshStoreError(503, REFRESH_STORE_ERROR_CODES.STORE_FAILED, 'x', { operation: 'read_hold' })
  assert.equal(translateByIdRead(failed, notFound), failed)
  const notOpen = new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.CONFIRM_STALE, 'x', { reason: 'hold_not_open' })
  assert.equal(translateByIdRead(notOpen, notFound), notOpen)
  assert.equal(translateByIdRead(new Error('plain'), notFound).message, 'plain')
})

// ── Step 5 PR-8: the change-plan legs ────────────────────────────────────────────────────────────

// A REAL consult (the real reader over the refresh kit) of a project with no row: ok, not governed.
async function realConsult() {
  const wiring = require('./support/stock-preparation-refresh-governance-wiring.cjs')
  const env = wiring.createRefreshGovernanceEnv()
  return env.governance.consult(SCOPE)
}

const is501 = (code, reason) => (error) => error.status === 501 && (code === undefined || error.code === code) && (reason === undefined || (error.details && error.details.reason === reason))

test('RD-CP1 the change-plan legs refuse a half-wired context by name (501) before any read: the page, the confirm and the review', async () => {
  const consult = await realConsult()
  assert.equal(consult.ok, true)
  const unexpected = (what) => async () => { throw new Error(`unexpected ${what}`) }
  const base = () => ({
    scope: SCOPE,
    actorId: 'u_rd',
    consult,
    store: { readHold: unexpected('readHold'), readContinuation: unexpected('readContinuation') },
    audit: { append: unexpected('audit append') },
  })
  const receipts = { record: unexpected('receipt record'), verify: unexpected('receipt verify') }
  // The page.
  await assert.rejects(() => decisions.readChangePlanCurrent(base()), is501(CODES.RECEIPT_STORE_UNAVAILABLE, 'receipts'))
  await assert.rejects(() => decisions.readChangePlanCurrent({ ...base(), receipts }), is501(CODES.STORE_UNAVAILABLE, 'decision_store'))
  const pending = {
    ...base(),
    receipts,
    consult: { ...consult, changePlans: [{ id: 'chp_rd', status: 'confirmed' }] },
    store: { ...base().store, readChangePlan: async () => ({ id: 'chp_rd', status: 'confirmed', recordSet: [], recordCount: 0 }) },
  }
  await assert.rejects(() => decisions.readChangePlanCurrent(pending), is501(CODES.STORE_UNAVAILABLE, 'sheet_reader'))
  // The confirm.
  const decisionBase = () => ({
    ...base(),
    store: { ...base().store, confirmContinuation: unexpected('confirm'), reconfirmContinuation: unexpected('reconfirm'), endContinuation: unexpected('end') },
    projectWriteLock: { bumpGenerationWithin: unexpected('bump') },
    audit: { append: unexpected('audit append'), appendWithin: unexpected('audit appendWithin') },
  })
  await assert.rejects(() => decisions.confirmChangePlan(decisionBase(), {}), is501(CODES.STORE_UNAVAILABLE, 'decision_store'))
  await assert.rejects(() => decisions.confirmChangePlan({ ...decisionBase(), store: { ...decisionBase().store, confirmChangePlan: unexpected('plan confirm') } }, {}), is501(CODES.RECEIPT_STORE_UNAVAILABLE, 'receipts'))
  // The review.
  const reviewStore = { ...base().store, readChangePlan: unexpected('plan read'), completeChangeReview: unexpected('review') }
  const withinAudit = { append: unexpected('audit append'), appendWithin: unexpected('audit appendWithin') }
  await assert.rejects(() => decisions.completeChangeReview(base(), {}), is501(CODES.STORE_UNAVAILABLE, 'decision_store'))
  await assert.rejects(() => decisions.completeChangeReview({ ...base(), store: reviewStore }, {}), is501('AUDIT_STORE_UNAVAILABLE', 'append_within'))
  await assert.rejects(() => decisions.completeChangeReview({ ...base(), store: reviewStore, audit: withinAudit }, {}), is501(CODES.RECEIPT_STORE_UNAVAILABLE, 'receipts'))
  await assert.rejects(() => decisions.completeChangeReview({ ...base(), store: reviewStore, audit: withinAudit, receipts }, {}), is501(undefined, 'assert_no_live_writer'))
  await assert.rejects(() => decisions.completeChangeReview({ ...base(), store: reviewStore, audit: withinAudit, receipts, projectWriteLock: { assertNoLiveWriter: unexpected('live writer') } }, {}), is501(CODES.STORE_UNAVAILABLE, 'sheet_reader'))
})

test('RD-CP2 the change-plan body normalizers refuse field by field (400, the field named), trim ids and echoes, carry the combined candidates and the review\'s optional notes', () => {
  const good = { holdIds: [' hold_1 ', 'hold_2'], holdSetFingerprint: ' a ', planFingerprint: 'b', sourceContentDigest: 'c', readReceipt: 'e'.repeat(32) }
  const out = normalizeChangePlanConfirmBody(good)
  assert.deepEqual(out.holdIds, ['hold_1', 'hold_2'])
  assert.deepEqual(out.echo, { holdSetFingerprint: 'a', planFingerprint: 'b', sourceContentDigest: 'c' })
  assert.equal(out.readReceipt, 'e'.repeat(32))
  assert.deepEqual(out.candidates, [])
  const combined = normalizeChangePlanConfirmBody({ ...good, candidates: [{ holdId: ' hold_1 ', candidateId: 'x', basis: { kind: 'puller_confirmed_same_demand', note: 'n' }, acknowledge: { historyUnknown: true } }, { holdId: 'hold_2', candidateId: 'y', basis: { kind: 'puller_confirmed_same_demand' } }] })
  assert.deepEqual(JSON.parse(JSON.stringify(combined.candidates)), [
    { holdId: 'hold_1', candidateId: 'x', basis: { kind: 'puller_confirmed_same_demand', note: 'n' }, historyUnknownAcknowledged: true },
    { holdId: 'hold_2', candidateId: 'y', basis: { kind: 'puller_confirmed_same_demand' }, historyUnknownAcknowledged: false },
  ])
  for (const [label, mutate, field] of [
    ['not an object', () => 'x', 'body'],
    ['no holdIds', (b) => { delete b.holdIds }, 'holdIds'],
    ['empty holdIds', (b) => { b.holdIds = [] }, 'holdIds'],
    ['a blank hold id', (b) => { b.holdIds = ['hold_1', ' '] }, 'holdIds'],
    ['a hold named twice', (b) => { b.holdIds = ['hold_1', ' hold_1'] }, 'holdIds'],
    ['no hold-set echo', (b) => { delete b.holdSetFingerprint }, 'holdSetFingerprint'],
    ['blank plan echo', (b) => { b.planFingerprint = ' ' }, 'planFingerprint'],
    ['no source echo', (b) => { delete b.sourceContentDigest }, 'sourceContentDigest'],
    ['no receipt', (b) => { delete b.readReceipt }, 'readReceipt'],
    ['candidates not a list', (b) => { b.candidates = {} }, 'candidates'],
    ['a candidate without its id', (b) => { b.candidates = [{ holdId: 'hold_1', basis: { kind: 'puller_confirmed_same_demand' } }] }, 'candidates[0]'],
    ['a candidate basis token', (b) => { b.candidates = [{ holdId: 'hold_1', candidateId: 'x', basis: { kind: 'other' } }] }, 'candidates[0].basis.kind'],
    ['a candidate basis note type', (b) => { b.candidates = [{ holdId: 'hold_1', candidateId: 'x', basis: { kind: 'puller_confirmed_same_demand', note: 3 } }] }, 'candidates[0].basis.note'],
    ['a candidate acknowledgement type', (b) => { b.candidates = [{ holdId: 'hold_1', candidateId: 'x', basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: 'yes' } }] }, 'candidates[0].acknowledge'],
  ]) {
    const body = label === 'not an object' ? mutate() : (() => { const b = JSON.parse(JSON.stringify(good)); mutate(b); return b })()
    assert.throws(() => normalizeChangePlanConfirmBody(body), (error) => error.status === 400 && error.code === CODES.REQUEST_INVALID && error.details.field === field, label)
  }
  const goodReview = { changePlanId: ' chp_1 ', contentDigest: ' d ', conclusion: 'handled_with_notes', notes: 'n', readReceipt: 'e'.repeat(32) }
  assert.deepEqual({ ...normalizeReviewBody(goodReview) }, { changePlanId: 'chp_1', contentDigest: 'd', conclusion: 'handled_with_notes', notes: 'n', readReceipt: 'e'.repeat(32) })
  assert.equal(normalizeReviewBody({ ...goodReview, notes: undefined, conclusion: 'handled' }).notes, null)
  for (const [label, mutate, field] of [
    ['not an object', () => null, 'body'],
    ['no plan id', (b) => { delete b.changePlanId }, 'changePlanId'],
    ['no digest', (b) => { b.contentDigest = '' }, 'contentDigest'],
    ['a conclusion outside the closed set', (b) => { b.conclusion = 'approved' }, 'conclusion'],
    ['notes not a string', (b) => { b.notes = ['n'] }, 'notes'],
    ['no receipt', (b) => { delete b.readReceipt }, 'readReceipt'],
  ]) {
    const body = label === 'not an object' ? mutate() : (() => { const b = JSON.parse(JSON.stringify(goodReview)); mutate(b); return b })()
    assert.throws(() => normalizeReviewBody(body), (error) => error.status === 400 && error.code === CODES.REQUEST_INVALID && error.details.field === field, label)
  }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-refresh-decisions.test.cjs', tests)
