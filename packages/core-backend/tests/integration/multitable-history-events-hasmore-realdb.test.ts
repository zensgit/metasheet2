/**
 * Global History — T2b-perf `?countMode=estimate` hasMore goldens (real DB).
 *
 * The base-level history center (GET /bases/:baseId/history/events) computes an EXACT post-LOCK-3 `total` by
 * default. `?countMode=estimate` skips that exact total and answers only the cheap question "are there MORE than
 * `offset+limit` VISIBLE batches?" (`hasMore`), early-stopping the scan one batch past the page (see
 * `estimateHistoryHasMore`). These goldens pin the SECURITY-SENSITIVE contract of that opt-in:
 *
 *   - LEAK-GUARD (the load-bearing one): a row-DENIED batch — the would-be (limit+1)th when counted — must NOT
 *     flip `hasMore` for an actor who can't see it. The estimate scan runs the SAME LOCK-3 row-deny filter
 *     (`loadDeniedBySheet` + `isDenied`) BEFORE a batch counts toward `hasMore`, so a denied record can never
 *     reveal its existence via a `hasMore` flip. The MUTATION-CHECK (dropping that Phase-1 `isDenied` gate makes
 *     this golden RED) is documented in the PR; the admin-bypass companion below is its non-vacuousness control
 *     (an admin DOES see the denied batch → hasMore=true, proving the denied batch is genuinely load-bearing).
 *   - hasMore is TRUE when a visible batch exists past the page, FALSE on the last page.
 *   - DEFAULT (no countMode) response is byte-for-byte the legacy shape: { batches, total, nextCursor,
 *     searchTruncated } with the EXACT total — full back-compat.
 *   - PARITY: for identical params, estimate returns the SAME page batches as the exact path, and
 *     estimate.hasMore === (exact.total > offset+limit) — across page0 / last-page / row-deny / admin. This is
 *     the regression net for the two-phase ordering/slicing logic (the leak-guard + cardinality cases alone do
 *     not pin page CONTENTS).
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in the real-DB allowlist step).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { estimateHistoryHasMore, loadHistoryBatchSummaries } from '../../src/multitable/history-projection'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_ghhm_${TS}`
const SHEET_ID = `sheet_ghhm_${TS}`
const STATUS = `fld_ghhm_status_${TS}`
const USER_ID = `user_ghhm_${TS}`
// Three VISIBLE (public) records, each its own single-record batch, + one SECRET record (row-deniable).
const REC_PUB_A = `rec_ghhm_pub_a_${TS}`
const REC_PUB_B = `rec_ghhm_pub_b_${TS}`
const REC_PUB_C = `rec_ghhm_pub_c_${TS}`
const REC_SECRET = `rec_ghhm_secret_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let testUserId = USER_ID
let testPerms: string[] = ['multitable:read', 'multitable:write']
let testRoles: string[] = ['member']

const setFlag = (on: boolean) => q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [SHEET_ID, on])
const setRules = (rules: unknown[]) => q('UPDATE meta_sheets SET conditional_read_rules = $2::jsonb WHERE id = $1', [SHEET_ID, JSON.stringify(rules)])
const denySecretRule = [{ id: 'r1', fieldId: STATUS, operator: 'eq', value: 'secret', effect: 'deny_read' }]

// Each batch is a single-record action at an EXPLICIT created_at + batch_id, so we control the newest-first order
// precisely (the leak-guard needs the DENIED batch to be the OLDEST — the would-be (limit+1)th if counted).
const revAt = (recordId: string, status: string, batchId: string, createdAt: string) =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id, created_at)
     VALUES (gen_random_uuid(), $1, $2, 1, 'update', 'rest', $3, ARRAY[$4]::text[], '{}'::jsonb, $5::jsonb, $6, $7)`,
    [SHEET_ID, recordId, USER_ID, STATUS, JSON.stringify({ [STATUS]: status }), batchId, createdAt],
  )

const events = (query: Record<string, unknown> = {}) =>
  request(app).get(`/api/multitable/bases/${BASE_ID}/history/events`).query(query)
const batchIds = (res: { body?: { data?: { batches?: Array<{ batchId: string }> } } }) =>
  (res.body?.data?.batches ?? []).map((b) => b.batchId)

// Seed three VISIBLE batches (newest→oldest) and ONE DENIED batch as the OLDEST. With limit=2, offset=0 and the
// deny flag ON, a non-admin sees exactly the 2 newest (visible) → hasMore must be FALSE (the denied oldest batch,
// the would-be 3rd, is filtered before counting). batchIds are explicit so order/selection are deterministic.
const B_NEW = `batch_ghhm_new_${TS}` // newest visible
const B_MID = `batch_ghhm_mid_${TS}` // middle visible
const B_OLD = `batch_ghhm_old_${TS}` // oldest visible
const B_SECRET = `batch_ghhm_secret_${TS}` // DENIED, OLDEST of all → the would-be (limit+1)th when counted
const T_NEW = new Date(TS - 1000).toISOString()
const T_MID = new Date(TS - 2000).toISOString()
const T_OLD = new Date(TS - 3000).toISOString()
const T_SECRET = new Date(TS - 4000).toISOString() // strictly oldest

const seedLeakGuard = async () => {
  await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID])
  await revAt(REC_PUB_A, 'public', B_NEW, T_NEW)
  await revAt(REC_PUB_B, 'public', B_MID, T_MID)
  await revAt(REC_PUB_C, 'public', B_OLD, T_OLD)
  await revAt(REC_SECRET, 'secret', B_SECRET, T_SECRET) // denied (status='secret') when flag+rule on; oldest
}

describeIfDatabase('global-history events — estimate hasMore goldens (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: testRoles, perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'GHHM Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'GHHM Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [STATUS, SHEET_ID, 'Status', 'select', '{}', 1])
    for (const rid of [REC_PUB_A, REC_PUB_B, REC_PUB_C, REC_SECRET]) {
      const status = rid === REC_SECRET ? 'secret' : 'public'
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [rid, SHEET_ID, JSON.stringify({ [STATUS]: status })])
    }
  })

  afterAll(async () => {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  afterEach(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
  })

  beforeEach(async () => {
    testUserId = USER_ID
    testPerms = ['multitable:read', 'multitable:write']
    testRoles = ['member']
    await setFlag(false)
    await setRules([])
    await seedLeakGuard()
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ---------- LEAK-GUARD (the load-bearing security golden) ----------

  test('LEAK-GUARD: a row-denied OLDEST batch (the would-be limit+1th) does NOT flip hasMore for an actor who cannot see it', async () => {
    await setFlag(true)
    await setRules(denySecretRule) // REC_SECRET (status='secret') is row-denied → B_SECRET invisible to USER_ID
    // limit=3, offset=0: the actor sees EXACTLY the 3 visible batches; the denied oldest batch is the would-be 4th.
    // With only those 3 visible, the ONLY thing that could push past the page is the denied batch — so hasMore is
    // the load-bearing assertion: it MUST be false, else the denied record's existence leaks via the flip.
    const res = await events({ countMode: 'estimate', limit: 3, offset: 0 })
    expect(res.status).toBe(200)
    expect(res.body?.data?.countMode).toBe('estimate')
    expect(res.body?.data?.hasMore).toBe(false) // ← the leak-guard: denied batch filtered BEFORE the hasMore count
    expect(batchIds(res)).toEqual([B_NEW, B_MID, B_OLD]) // page = the 3 visible, newest→oldest
    expect(batchIds(res)).not.toContain(B_SECRET) // the denied batch never appears
    expect(res.body?.data?.nextCursor).toBeNull() // no next page (the only remaining batch is denied)
  })

  test('LEAK-GUARD control (non-vacuous): an ADMIN — who bypasses row-deny — DOES see the denied batch flip hasMore', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    testRoles = ['admin'] // admin bypasses the LOCK-3 row layer → B_SECRET is the genuine (limit+1)th visible batch
    const res = await events({ countMode: 'estimate', limit: 3, offset: 0 })
    expect(res.status).toBe(200)
    // Proves the denied batch is REALLY the load-bearing 4th: with the row layer off (admin), the SAME seed +
    // SAME params now flip hasMore=true. Together with the leak-guard above, this is the mutation-check's
    // permanent non-vacuousness control — the ONLY difference from the leak-guard is whether LOCK-3 row-deny
    // applies to the actor. (If the leak-guard's `false` were vacuous, this `true` could not differ.)
    expect(res.body?.data?.hasMore).toBe(true)
    expect(batchIds(res)).toEqual([B_NEW, B_MID, B_OLD]) // still the 3 newest on the page (B_SECRET is the off-page 4th)
  })

  // ---------- hasMore correctness (cardinality) ----------

  test('estimate hasMore=TRUE when a visible batch exists past the page (limit=2 of 3 visible, flag off)', async () => {
    // flag off (beforeEach) → all 4 batches visible. limit=2, offset=0 → 2 on the page, ≥1 more visible → true.
    const res = await events({ countMode: 'estimate', limit: 2, offset: 0 })
    expect(res.status).toBe(200)
    expect(res.body?.data?.hasMore).toBe(true)
    expect(batchIds(res)).toEqual([B_NEW, B_MID])
    expect(res.body?.data?.nextCursor).toBeTruthy() // a next cursor is offered when more remain
  })

  test('estimate hasMore=FALSE on the LAST page (offset=2, limit=2: the tail of 4 visible batches)', async () => {
    const res = await events({ countMode: 'estimate', limit: 2, offset: 2 })
    expect(res.status).toBe(200)
    expect(res.body?.data?.hasMore).toBe(false) // batches 3 & 4 of 4 → nothing past this page
    expect(batchIds(res)).toEqual([B_OLD, B_SECRET]) // the 2 oldest (flag off → secret visible)
    expect(res.body?.data?.nextCursor).toBeNull()
  })

  test('estimate hasMore=FALSE when the page covers ALL visible batches (limit=100 ≥ 4)', async () => {
    const res = await events({ countMode: 'estimate', limit: 100, offset: 0 })
    expect(res.status).toBe(200)
    expect(res.body?.data?.hasMore).toBe(false)
    expect(batchIds(res)).toEqual([B_NEW, B_MID, B_OLD, B_SECRET]) // all four, newest→oldest
  })

  // ---------- DEFAULT back-compat (exact total, untouched response shape) ----------

  test('DEFAULT (no countMode) returns the EXACT total + legacy shape (no hasMore key); estimate omits total', async () => {
    const def = await events({ limit: 2, offset: 0 }) // no countMode → exact path, byte-for-byte legacy
    expect(def.status).toBe(200)
    expect(def.body?.data?.total).toBe(4) // exact post-LOCK-3 total (flag off → all 4 visible)
    expect(def.body?.data).toHaveProperty('searchTruncated') // legacy keys present…
    expect(def.body?.data).not.toHaveProperty('hasMore') // …and NO hasMore on the default response
    expect(def.body?.data).not.toHaveProperty('countMode')
    const est = await events({ countMode: 'estimate', limit: 2, offset: 0 })
    expect(est.body?.data).not.toHaveProperty('total') // estimate intentionally omits the (expensive) exact total
    expect(est.body?.data).toHaveProperty('hasMore')
  })

  test('estimate does NOT compose with search/fieldId/cursor — those fall back to the EXACT path (total present)', async () => {
    // The route scopes estimate to the plain list; a search request keeps the exact total (and searchTruncated).
    const withSearch = await events({ countMode: 'estimate', q: 'public', limit: 2 })
    expect(withSearch.status).toBe(200)
    expect(withSearch.body?.data).toHaveProperty('total') // exact path served it → total present
    expect(withSearch.body?.data).not.toHaveProperty('hasMore') // NOT the estimate shape
    const withField = await events({ countMode: 'estimate', fieldId: STATUS, limit: 2 })
    expect(withField.body?.data).toHaveProperty('total') // fieldId → exact path
    expect(withField.body?.data).not.toHaveProperty('hasMore')
  })

  // ---------- PARITY: estimate page == exact page; hasMore == (exact.total > offset+limit) ----------
  // The regression net for the two-phase ordering/slicing logic. Calls the projection functions directly with
  // identical params, deep-comparing the page batches and the hasMore↔total relationship across scenarios.

  const allowed = () => new Map([[SHEET_ID, new Set([STATUS])]])
  const parityCase = async (label: string, access: { userId: string; isAdminRole: boolean }, limit: number, offset: number, flagOn: boolean, estimateScanChunk?: number) => {
    if (flagOn) { await setFlag(true); await setRules(denySecretRule) } else { await setFlag(false); await setRules([]) }
    const base = { sheetIds: [SHEET_ID], allowedFieldsBySheet: allowed(), limit, offset }
    const exact = await loadHistoryBatchSummaries(q, base, access)
    const est = await estimateHistoryHasMore(q, { ...base, estimateScanChunk }, access)
    // page CONTENTS identical (same batches, same order, same masked counts) — catches an ordering/slicing bug.
    expect(est.batches, `${label}: page batches`).toEqual(exact.batches)
    // hasMore is exactly "is there a visible batch past this page" = (exact total > offset+limit).
    expect(est.hasMore, `${label}: hasMore`).toBe(exact.total > offset + limit)
  }

  test('PARITY: estimate page + hasMore match the exact path across page0 / last-page / row-deny / admin', async () => {
    const member = { userId: USER_ID, isAdminRole: false }
    const admin = { userId: USER_ID, isAdminRole: true }
    await parityCase('page0 flag-off member', member, 2, 0, false)
    await parityCase('last-page flag-off member', member, 2, 2, false)
    await parityCase('all-on-one-page flag-off member', member, 100, 0, false)
    await parityCase('page0 row-deny member (denied oldest off-page)', member, 2, 0, true)
    await parityCase('last-visible-page row-deny member', member, 3, 0, true) // 3 visible → page of 3, hasMore=false
    await parityCase('page0 row-deny admin (denied batch visible)', admin, 2, 0, true)
    await parityCase('last-page row-deny admin', admin, 2, 2, true)
  })

  // ---------- MULTI-CHUNK keyset cursor (the chunk path the 4-row goldens never exercise) ----------
  // With the default chunk size (500) the 4-row seed always returns < chunk → exhausted on the first query, so the
  // keyset cursor block never runs. estimateScanChunk:1 FORCES one row per round-trip → the cursor is exercised on
  // every page boundary. This is the regression net for the cursor's full-precision round-trip: node-pg parses
  // timestamptz → a millisecond JS Date, so a cursor built from that Date would TRUNCATE sub-millisecond precision
  // and silently SKIP any unprocessed row in the truncated gap (undercount → hasMore wrongly false / dropped page
  // batch). The seed below puts rows in the SAME millisecond but DIFFERENT microseconds to trip exactly that bug.

  test('MULTI-CHUNK: chunk=1 keyset pagination matches the exact path (4 distinct-time visible batches)', async () => {
    // distinct seconds-apart created_ats: chunk=1 walks all four via the keyset cursor, one per round-trip.
    const member = { userId: USER_ID, isAdminRole: false }
    await parityCase('chunk1 page0 of 4', member, 2, 0, false, 1)
    await parityCase('chunk1 last-page of 4', member, 2, 2, false, 1)
    await parityCase('chunk1 all-on-one-page', member, 100, 0, false, 1)
    await parityCase('chunk1 page0 row-deny (denied oldest off-page)', member, 2, 0, true, 1)
  })

  test('MULTI-CHUNK cursor precision: microsecond-adjacent rows in ONE millisecond are NOT skipped at a chunk boundary', async () => {
    // Replace the seed with 5 single-record VISIBLE batches whose created_ats share the SAME millisecond but differ
    // by MICROSECONDS (…10.000500Z … 10.000100Z). A ms-truncating keyset cursor would, after emitting the first,
    // bind a boundary of …10.000(000) and EXCLUDE the rest (all > .000000) → return 0 → think it's exhausted → drop
    // 4 visible batches. The full-precision (created_at::text) cursor re-parses the exact stored value → no skip.
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID])
    const micro = ['10.000500', '10.000400', '10.000300', '10.000200', '10.000100'] // same ms (10.000), descending µs
    const keys: string[] = []
    for (let i = 0; i < micro.length; i++) {
      const k = `batch_ghhm_us_${i}_${TS}`
      keys.push(k)
      await revAt(REC_PUB_A, 'public', k, `2026-06-20T00:00:${micro[i]}Z`) // record id reused; batch_id is the group key
    }
    const member = { userId: USER_ID, isAdminRole: false }
    await setFlag(false); await setRules([])
    const base = { sheetIds: [SHEET_ID], allowedFieldsBySheet: allowed(), limit: 2, offset: 0 }
    const exact = await loadHistoryBatchSummaries(q, base, member)
    const estChunk1 = await estimateHistoryHasMore(q, { ...base, estimateScanChunk: 1 }, member)
    // The exact path sees all 5 visible batches → total 5; estimate (chunk=1) must agree it has more past page 1…
    expect(exact.total).toBe(5)
    expect(estChunk1.hasMore).toBe(true) // ← would be FALSE under a ms-truncating cursor (4 batches skipped)
    expect(estChunk1.batches).toEqual(exact.batches) // …and return the SAME page-0 batches (no skip/reorder)
    // A deep page (offset=4 → the 5th/last visible batch) likewise must resolve through 5 chunk hops, not stall.
    const lastPage = await estimateHistoryHasMore(q, { ...base, offset: 4, estimateScanChunk: 1 }, member)
    const exactLast = await loadHistoryBatchSummaries(q, { ...base, offset: 4 }, member)
    expect(lastPage.hasMore).toBe(false) // offset 4 of 5 → nothing past the last batch
    expect(lastPage.batches).toEqual(exactLast.batches) // the single last batch, reached via the keyset cursor (parity with exact)
    // Same-MILLISECOND batches order by batchId DESC (the SHIPPED exact-path comparator: ms-truncated created_at then
    // batchId) — NOT by µs. So offset-4 of [us_4,us_3,us_2,us_1,us_0] is the LOWEST batchId = keys[0] (batch_ghhm_us_0),
    // which is exactly what the exact path returns (asserted above). Cursor precision (no µs-adjacent row skipped) is
    // proven by total=5 + the page-parity assertions, not by which same-ms batch lands last.
    expect(lastPage.batches.map((b) => b.batchId)).toEqual([keys[0]])
  })
})
