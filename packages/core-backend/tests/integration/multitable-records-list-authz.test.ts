/**
 * Real-DB integration test for F0a — GET /records (cursor list) authorization + field-read mask.
 * Design-lock: docs/development/multitable-record-egress-fieldperm-inventory-20260529.md (#2106), §3 F0a + §4.
 *
 * GET /records had NO authorization (no canRead, no record-permission filter, no field mask) and a
 * subject-less response cache, so any authenticated user could read any sheet's full records by id; and
 * `filter.*`/`sortField` over a denied field was a value/ordering oracle a data mask alone would not close.
 * F0a lands all five together: canRead → field mask (layer-2 ∧ layer-3) → filter/sort selection gate (400)
 * → cache disabled → record-permission filter.
 *
 * Fail-first (origin/main RED): T1/T2 (authz), T3 (mask), T4/T4b/T5 (selection gate) were demonstrated RED
 * against unmodified origin/main (200 + leaked canary / a working oracle) and GREEN after the fix.
 * T6 (cache) CANNOT RED on origin/main — pre-fix there is no mask, so both subjects receive identical full
 * data and there is nothing to cross-contaminate. It was demonstrated RED against an INTERMEDIATE state
 * (mask added but the subject-less cache KEPT: subject B was served subject A's cached masked body) and GREEN
 * once the cache was removed (directive #4) — proving the cache was a real leak vector. It stands here as the
 * forward regression guard.
 *
 * Seed non-negotiable: FLD_SECRET.property = {} (property.hidden UNSET) so the deny is SOLELY layer-3
 * (field_permissions.visible=false). If it were also static-hidden, layer-2 would mask it on origin/main and
 * the mask/selection tests would prove nothing.
 *
 * Anti-oracle: a denied field and a NON-EXISTENT field must both 400 with the SAME status AND message (T4 vs
 * T4b) so filter/sort cannot be used to probe field existence.
 *
 * Runs only with DATABASE_URL (describeIfDatabase + a sentinel test so it fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
// IDs namespaced (`*_f0a_*_${TS}`) — meta_fields.id / meta_records.id are global PKs; siblings share the DB.
const BASE_ID = `base_f0a_${TS}`
const SHEET_ID = `sheet_f0a_${TS}`
const FLD_VISIBLE = `fld_f0a_visible_${TS}` // never denied — the positive control
const FLD_SECRET = `fld_f0a_secret_${TS}` // denied to USER_ID via field_permissions.visible=false (layer-3 only)
const REC_ID = `rec_f0a_${TS}`
const USER_ID = `u_f0a_${TS}` // FLD_SECRET denied to this subject
const USER_ID_2 = `u_f0a_other_${TS}` // NO deny row → must still see FLD_SECRET (per-subject, grant-additive)
const VISIBLE_VALUE = 10
const SECRET_CANARY = 'do-not-leak-records-canary'

let app: Express
let testUserId: string = USER_ID // mutable: a test can drop the user (401), swap subject, or strip perms (403)
let testPerms: string[] = ['multitable:read']

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const recordsReq = (query: Record<string, string>) =>
  request(app).get('/api/multitable/records').query(query)
const recOf = (res: { body: { data?: { records?: Array<{ id: string }> } } }) =>
  res.body.data?.records?.find((r) => r.id === REC_ID)

describeIfDatabase('F0a GET /records authz + field mask (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'F0a Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'F0a Sheet'])
    // property `{}` → property.hidden UNSET. The deny must come solely from layer-3 (below).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VISIBLE, SHEET_ID, 'Visible', 'number', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRET, SHEET_ID, 'Secret', 'string', '{}', 2])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_ID, SHEET_ID, JSON.stringify({ [FLD_VISIBLE]: VISIBLE_VALUE, [FLD_SECRET]: SECRET_CANARY })])
    // The real field-read deny gate: subject-scoped, layer-3. USER_ID_2 gets NO row (T6 control).
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER_ID, false, false])
  })

  afterAll(async () => {
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('T1 (authz): a non-reader (no read capability, no sheet grant) gets 403, never raw data', async () => {
    testUserId = USER_ID; testPerms = [] // no multitable:read → canRead=false
    const res = await recordsReq({ sheetId: SHEET_ID })
    expect(res.status).toBe(403)
    expect(res.body.data).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY)
    testPerms = ['multitable:read']
  })

  test('T2 (authz): unauthenticated → 401 (handler does not rely on the global gate alone)', async () => {
    testUserId = ''
    const res = await recordsReq({ sheetId: SHEET_ID })
    expect(res.status).toBe(401)
    testUserId = USER_ID
  })

  test('T3 (field mask): a field_permissions-denied value is omitted from records[].data (canary never on the wire)', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    const res = await recordsReq({ sheetId: SHEET_ID })
    expect(res.status).toBe(200)
    const rec = recOf(res)
    expect(rec).toBeDefined() // positive control: record present (defeats an empty-response false-green)
    expect((rec as any).data[FLD_VISIBLE]).toBe(VISIBLE_VALUE)
    expect((rec as any).data[FLD_SECRET]).toBeUndefined() // THE LEAK (RED pre-fix, GREEN post-fix)
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY)
    // GET /records returns only {id,version,data} from raw JSONB — no link/attachment summary channel.
    // Assert it stays that way so a future summary addition can't silently reopen the leak.
    expect(res.body.data.linkSummaries).toBeUndefined()
    expect(res.body.data.attachmentSummaries).toBeUndefined()
  })

  test('T4 (selection gate): filter on a denied field → 400; filter on a readable field → 200 and matches', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    const denied = await recordsReq({ sheetId: SHEET_ID, [`filter.${FLD_SECRET}`]: SECRET_CANARY })
    expect(denied.status).toBe(400)
    expect(denied.body.error.code).toBe('VALIDATION_ERROR')
    const ok = await recordsReq({ sheetId: SHEET_ID, [`filter.${FLD_VISIBLE}`]: String(VISIBLE_VALUE) })
    expect(ok.status).toBe(200)
    expect(recOf(ok)).toBeDefined()
  })

  test('T4b (anti-oracle): a NON-EXISTENT filter field → 400 with the SAME status AND message as a denied field', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    const denied = await recordsReq({ sheetId: SHEET_ID, [`filter.${FLD_SECRET}`]: 'x' })
    const missing = await recordsReq({ sheetId: SHEET_ID, [`filter.fld_does_not_exist_${TS}`]: 'x' })
    expect(denied.status).toBe(400)
    expect(missing.status).toBe(400)
    // identical status + code + message → filter cannot be used to probe field existence
    expect(missing.body.error.code).toBe(denied.body.error.code)
    expect(missing.body.error.message).toBe(denied.body.error.message)
  })

  test('T5 (selection gate): sort on a denied field → 400; sort on a readable field → 200', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    const denied = await recordsReq({ sheetId: SHEET_ID, sortField: FLD_SECRET })
    expect(denied.status).toBe(400)
    expect(denied.body.error.code).toBe('VALIDATION_ERROR')
    const ok = await recordsReq({ sheetId: SHEET_ID, sortField: FLD_VISIBLE })
    expect(ok.status).toBe(200)
  })

  test('T6 (cache/per-subject): same query, two subjects → each gets its own mask (no cross-subject cache)', async () => {
    // origin/main cannot RED this (no mask pre-fix → both subjects get identical full data, nothing to
    // cross-contaminate). It was demonstrated RED against the intermediate "mask added, subject-less cache
    // KEPT" state (subject B received subject A's cached masked body) and GREEN after the cache was removed.
    testUserId = USER_ID; testPerms = ['multitable:read'] // denied subject FIRST (would populate a cache)
    const a = await recordsReq({ sheetId: SHEET_ID })
    expect(a.status).toBe(200)
    expect((recOf(a) as any).data[FLD_SECRET]).toBeUndefined()

    testUserId = USER_ID_2; testPerms = ['multitable:read'] // granted subject, IDENTICAL query
    const b = await recordsReq({ sheetId: SHEET_ID })
    expect(b.status).toBe(200)
    expect((recOf(b) as any).data[FLD_SECRET]).toBe(SECRET_CANARY)
    testUserId = USER_ID
  })

  test('T7 (record-permission filter): with record_permissions present, a granted subject still sees the record', async () => {
    // Read is grant-additive (golden: record-read is a non-gate), so the filter is inert — this proves the
    // branch runs (hasRecordPermissionAssignments → true) and does not over-drop a readable record
    // (record-scope parity with GET /view).
    testUserId = USER_ID; testPerms = ['multitable:read']
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)', [SHEET_ID, REC_ID, 'user', USER_ID, 'read'])
    const res = await recordsReq({ sheetId: SHEET_ID })
    expect(res.status).toBe(200)
    expect(recOf(res)).toBeDefined()
  })

  test('T8 (anti-oracle / no 500): a non-reader gets 403 for a NON-EXISTENT sheet too (no existence oracle; resolver does not throw)', async () => {
    testUserId = USER_ID; testPerms = [] // non-reader
    const res = await recordsReq({ sheetId: `sheet_f0a_missing_${TS}` })
    expect(res.status).toBe(403) // identical to T1's existing-but-denied sheet → indistinguishable, no 500
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY)
    testPerms = ['multitable:read']
  })
})
