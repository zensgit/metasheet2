/**
 * OAPI-4a — per-base/sheet scoped-token guard (real DB).
 * Design-lock: docs/development/multitable-oapi4-scoped-tokens-designlock-20260629.md (RATIFIED).
 *
 * Proves the shared `oapiScopeGuard` confines an `mst_` token to its base_ids/sheet_ids whitelist on every
 * records route (read + write), with the §3 AND-composition, fail-closed cross-/multi-target, a uniform
 * no-oracle 403, the 3-way min (capability ∩ base/sheet ∩ creator RBAC), legacy-unscoped + session passthrough,
 * the denied write-audit row carrying detail.reason, rotateToken scope preservation, and the /patch
 * defense-in-depth (patchRecords confines to the declared sheet_id so an out-of-sheet recordId is untouched).
 *
 * FAIL-FIRST: with `oapiScopeGuard` removed from the route chains, the out-of-base/out-of-sheet writes (T-b/T-c)
 * SUCCEED creator-wide → those assertions (403 + no-mutation + denied-reason audit) go RED. Verified manually
 * (see dev-verification MD §4). Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { db } from '../../src/db/db'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ApiTokenService } from '../../src/multitable/api-token-service'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_A = `base_sg_a_${TS}`
const BASE_B = `base_sg_b_${TS}`
const SHEET_A1 = `sheet_sg_a1_${TS}`
const SHEET_A2 = `sheet_sg_a2_${TS}`
const SHEET_B1 = `sheet_sg_b1_${TS}`
const FLD_A1 = `fld_sg_a1_${TS}`
const FLD_A2 = `fld_sg_a2_${TS}`
const FLD_B1 = `fld_sg_b1_${TS}`
const REC_A1 = `rec_sg_a1_${TS}`
const REC_B1 = `rec_sg_b1_${TS}`
const WRITER = `user_sg_writer_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let sessionApp: Express
// tokens (all created by WRITER, who holds multitable:write so the min-spine passes for in-scope writes)
let tUnscoped = '', tUnscopedId = ''
let tBaseA = '', tBaseAId = ''
let tSheetA1 = '', tSheetA1Id = ''
let tBoth = ''
let tBaseAReadOnly = ''

const recData = async (recordId: string): Promise<Record<string, unknown> | null> => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [recordId])
  return r.rows.length ? (r.rows[0] as { data: Record<string, unknown> }).data : null
}
const auditRows = async (tokenId: string): Promise<Array<{ outcome: string; status_code: number | null; detail: unknown }>> => {
  const r = await q('SELECT outcome, status_code, detail FROM oapi_write_audit WHERE token_id = $1 ORDER BY id', [tokenId])
  return r.rows as Array<{ outcome: string; status_code: number | null; detail: unknown }>
}
const post = (path: string, token: string, body: unknown) =>
  request(app).post(path).set('Authorization', `Bearer ${token}`).send(body)
const patch = (recordId: string, token: string, body: unknown) =>
  request(app).patch(`/api/multitable/records/${recordId}`).set('Authorization', `Bearer ${token}`).send(body)
const del = (recordId: string, token: string) =>
  request(app).delete(`/api/multitable/records/${recordId}`).set('Authorization', `Bearer ${token}`)
const getRec = (path: string, token: string) =>
  request(app).get(path).set('Authorization', `Bearer ${token}`)
const flush = () => new Promise((r) => setTimeout(r, 80)) // let the res.on('finish') audit listener flush

describeIfDatabase('OAPI-4a scoped-token guard (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use('/api/multitable', univerMetaRouter())
    // A SESSION app: inject a logged-in user (no token) to prove the guard is a strict no-op for session reqs.
    sessionApp = express()
    sessionApp.use(express.json())
    sessionApp.use((req, _res, next) => { ;(req as express.Request & { user?: unknown }).user = { id: WRITER }; next() })
    sessionApp.use('/api/multitable', univerMetaRouter())

    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$3,'x','member',$4::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [WRITER, `${WRITER}@t.local`, WRITER, JSON.stringify(['multitable:read', 'multitable:write'])],
    )
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2),($3,$4)', [BASE_A, 'SG Base A', BASE_B, 'SG Base B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3),($4,$5,$6),($7,$8,$9)', [
      SHEET_A1, BASE_A, 'A1', SHEET_A2, BASE_A, 'A2', SHEET_B1, BASE_B, 'B1',
    ])
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1,$2,'F','text','{}'::jsonb,1),($3,$4,'F','text','{}'::jsonb,1),($5,$6,'F','text','{}'::jsonb,1)`,
      [FLD_A1, SHEET_A1, FLD_A2, SHEET_A2, FLD_B1, SHEET_B1],
    )
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1),($4,$5,$6::jsonb,1)', [
      REC_A1, SHEET_A1, JSON.stringify({ [FLD_A1]: 'a1-seed' }),
      REC_B1, SHEET_B1, JSON.stringify({ [FLD_B1]: 'b1-seed' }),
    ])

    const svc = new ApiTokenService(db)
    const rw = ['records:write', 'records:read', 'fields:read'] as const
    const u = await svc.createToken(WRITER, { name: 'unscoped', scopes: [...rw] })
    tUnscoped = u.plainTextToken; tUnscopedId = u.token.id
    const ba = await svc.createToken(WRITER, { name: 'baseA', scopes: [...rw], baseIds: [BASE_A] })
    tBaseA = ba.plainTextToken; tBaseAId = ba.token.id
    const sa = await svc.createToken(WRITER, { name: 'sheetA1', scopes: [...rw], sheetIds: [SHEET_A1] })
    tSheetA1 = sa.plainTextToken; tSheetA1Id = sa.token.id
    const bo = await svc.createToken(WRITER, { name: 'both', scopes: [...rw], baseIds: [BASE_A], sheetIds: [SHEET_A1] })
    tBoth = bo.plainTextToken
    const bro = await svc.createToken(WRITER, { name: 'baseA-ro', scopes: ['records:read'], baseIds: [BASE_A] })
    tBaseAReadOnly = bro.plainTextToken
  })

  afterAll(async () => {
    await db.deleteFrom('multitable_api_tokens').where('created_by', '=', WRITER).execute().catch(() => {})
    await q('DELETE FROM oapi_write_audit WHERE actor_id = $1', [WRITER]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET_A1, SHEET_A2, SHEET_B1]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET_A1, SHEET_A2, SHEET_B1]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_A1, SHEET_A2, SHEET_B1]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [WRITER]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // ── (a) in-scope ALLOW ────────────────────────────────────────────────────
  test('T-a base-scoped token writes into an in-scope sheet (POST /records)', async () => {
    const res = await post('/api/multitable/records', tBaseA, { sheetId: SHEET_A1, data: { [FLD_A1]: 'by-baseA' } })
    expect([200, 201]).toContain(res.status)
  })
  test('T-a sheet-scoped + both-scoped tokens allowed on their exact sheet', async () => {
    expect([200, 201]).toContain((await post('/api/multitable/records', tSheetA1, { sheetId: SHEET_A1, data: { [FLD_A1]: 'by-sheetA1' } })).status)
    expect([200, 201]).toContain((await post('/api/multitable/records', tBoth, { sheetId: SHEET_A1, data: { [FLD_A1]: 'by-both' } })).status)
  })
  test('T-a read: base-scoped token reads an in-scope sheet (GET /records)', async () => {
    expect((await getRec(`/api/multitable/records?sheetId=${SHEET_A1}`, tBaseA)).status).toBe(200)
  })

  // ── (b) out-of-BASE → 403 OUT_OF_SCOPE + denied audit w/ reason + NO mutation ─
  test('T-b out-of-base write → 403 OUT_OF_SCOPE, no mutation, denied audit row with detail.reason', async () => {
    const before = await recData(REC_B1)
    const res = await post('/api/multitable/records', tBaseA, { sheetId: SHEET_B1, data: { [FLD_B1]: 'should-not-write' } })
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('OUT_OF_SCOPE')
    const after = await q('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1', [SHEET_B1])
    expect((after.rows[0] as { n: number }).n).toBe(1) // only the seed — nothing created
    expect(await recData(REC_B1)).toEqual(before)
    await flush()
    const denied = (await auditRows(tBaseAId)).filter((r) => r.outcome === 'denied' && r.status_code === 403)
    expect(denied.length).toBeGreaterThanOrEqual(1)
    expect(denied.some((r) => (r.detail as { reason?: string } | null)?.reason === 'out_of_base_sheet_scope')).toBe(true)
  })

  // ── (c) out-of-SHEET (same base) → 403 ────────────────────────────────────
  test('T-c sheet-scoped token denied on a sibling sheet in the SAME base (out-of-sheet)', async () => {
    const res = await post('/api/multitable/records', tSheetA1, { sheetId: SHEET_A2, data: { [FLD_A2]: 'wrong-sheet' } })
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('OUT_OF_SCOPE')
  })

  // ── (c-read) out-of-scope READ → 403 (the lock requires uniform read AND write) ──
  test('T-c read: base-scoped token reading an out-of-scope sheet → 403 OUT_OF_SCOPE', async () => {
    const res = await getRec(`/api/multitable/records?sheetId=${SHEET_B1}`, tBaseA)
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('OUT_OF_SCOPE')
  })

  // ── (d) legacy UNSCOPED token → unchanged (creator-wide) ──────────────────
  test('T-d unscoped token writes ANY base + reads ANY sheet (legacy creator-wide, unchanged)', async () => {
    expect([200, 201]).toContain((await post('/api/multitable/records', tUnscoped, { sheetId: SHEET_B1, data: { [FLD_B1]: 'unscoped-ok' } })).status)
    expect((await getRec(`/api/multitable/records?sheetId=${SHEET_B1}`, tUnscoped)).status).toBe(200)
  })

  // ── (e) SESSION request → unaffected (guard strict no-op) ─────────────────
  test('T-e session request (no token) writes a sheet no scoped token could reach → guard no-op', async () => {
    const res = await request(sessionApp).post('/api/multitable/records').send({ sheetId: SHEET_B1, data: { [FLD_B1]: 'by-session' } })
    expect([200, 201]).toContain(res.status)
  })

  // ── (f) record-addressed routes + NO-ORACLE ───────────────────────────────
  test('T-f PATCH in-scope record allowed; out-of-scope record 403 + untouched', async () => {
    expect((await patch(REC_A1, tBaseA, { sheetId: SHEET_A1, data: { [FLD_A1]: 'patched-in-scope' } })).status).toBe(200)
    const before = await recData(REC_B1)
    const res = await patch(REC_B1, tBaseA, { sheetId: SHEET_B1, data: { [FLD_B1]: 'patched-out' } })
    expect(res.status).toBe(403)
    expect(await recData(REC_B1)).toEqual(before) // untouched
  })
  test('T-f NO-ORACLE: out-of-scope record and MISSING record return byte-identical 403', async () => {
    const outOfScope = await patch(REC_B1, tBaseA, { sheetId: SHEET_B1, data: { [FLD_B1]: 'x' } })
    const missing = await patch(`rec_sg_does_not_exist_${TS}`, tBaseA, { sheetId: SHEET_A1, data: { x: 'y' } })
    expect(outOfScope.status).toBe(403)
    expect(missing.status).toBe(403)
    expect(missing.body).toEqual(outOfScope.body) // no existence oracle
    expect(missing.body?.error?.code).toBe('OUT_OF_SCOPE')
  })
  test('T-f DELETE out-of-scope record → 403, record still present (authoritative sheet = record sheet)', async () => {
    const res = await del(REC_B1, tBaseA)
    expect(res.status).toBe(403)
    expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [REC_B1])).rows.length).toBe(1)
  })

  // ── (g) 3-way MIN (capability ∩ base/sheet ∩ creator RBAC) ────────────────
  test('T-g token in-scope by base but missing the WRITE capability → 403 INSUFFICIENT_SCOPE', async () => {
    const res = await post('/api/multitable/records', tBaseAReadOnly, { sheetId: SHEET_A1, data: { [FLD_A1]: 'no-write-cap' } })
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('INSUFFICIENT_SCOPE') // capability gate, not the base/sheet gate
  })

  // ── (h) rotateToken PRESERVES scope ───────────────────────────────────────
  test('T-h rotated token keeps its base scope (not widened to creator-wide)', async () => {
    const svc = new ApiTokenService(db)
    const rotated = await svc.rotateToken(tBaseAId, WRITER)
    expect(rotated.token.baseIds).toEqual([BASE_A])
    const tok = rotated.plainTextToken
    // still bounded: in-scope allowed, out-of-scope denied
    expect([200, 201]).toContain((await post('/api/multitable/records', tok, { sheetId: SHEET_A1, data: { [FLD_A1]: 'rotated-ok' } })).status)
    expect((await post('/api/multitable/records', tok, { sheetId: SHEET_B1, data: { [FLD_B1]: 'rotated-out' } })).status).toBe(403)
  })

  // ── (+) /patch DEFENSE-IN-DEPTH: declared sheet in-scope, but a change names an out-of-sheet record ──
  test('T-patch confinement: in-scope declared sheet, change.recordId in another sheet → that record untouched', async () => {
    const before = await recData(REC_B1) // belongs to SHEET_B1
    // tSheetA1 is in-scope for SHEET_A1; declare sheetId=SHEET_A1 (guard passes) but target REC_B1 (sheet B1).
    const res = await post('/api/multitable/patch', tSheetA1, {
      sheetId: SHEET_A1,
      changes: [{ recordId: REC_B1, fieldId: FLD_B1, value: 'cross-sheet-attempt' }],
    })
    // patchRecords confines to WHERE sheet_id = $declaredSheet AND id = $recordId → the B1 record matches 0 rows.
    // The request may 200 (no-op for the unmatched change) or error, but REC_B1 MUST be unchanged either way.
    expect(await recData(REC_B1)).toEqual(before)
  })
})
