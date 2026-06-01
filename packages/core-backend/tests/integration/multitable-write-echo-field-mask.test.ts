/**
 * Real-DB integration test for F3 — write-path echo field mask.
 * Design-lock: docs/development/multitable-record-egress-fieldperm-inventory-20260529.md (#2106) §3 F3.
 *
 * PATCH /records/:recordId and POST /patch echo the written record back masked by the SAME-SHEET set
 * `visiblePropertyFieldIds` = LAYER-2 only (property.hidden). F3 upgrades the same-sheet echo to the
 * layer-2 ∧ layer-3 composite (the #2028 read-path pattern) so a `field_permissions.visible=false` value
 * is never echoed. The WRITE gate is untouched: writability is `canEditRecord` + `fieldById` (layer-2
 * hidden / readOnly / type), which never consults field_permissions — so a field can be WRITABLE yet
 * READ-denied (write-only-no-read). R2/R4 prove that exact case: PATCH FLD_SECRET itself succeeds and
 * PERSISTS, but the echo must still omit it. That is what F3 closes that F0a's read mask did not.
 *
 * Out of F3 scope (flagged separately in the verification doc): crossSheetRelated (returned UNMASKED at
 * record-write-service.ts:985 — a different mechanism needing per-related-sheet perms) and the realtime
 * broadcast (record-write-service.ts:~949 — a per-subscriber surface).
 *
 * POST /patch echoes ONLY computed/dependent data (`mergedRecords`), never a plain field — so a 2-field
 * sheet would make the POST /patch assertion VACUOUS (empty `records`, passes pre+post). R3 therefore uses
 * a FORMULA field (echoed at :882) with a USER_ID_2 positive-control FIRST, so the denied-omission is real.
 *
 * Seed non-negotiable: FLD_SECRET/FLD_FORMULA.property carry no `hidden` → deny is SOLELY layer-3.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_f3_${TS}`
const SHEET_ID = `sheet_f3_${TS}`
const FLD_VISIBLE = `fld_f3_visible_${TS}` // number, readable — formula source + positive control
const FLD_SECRET = `fld_f3_secret_${TS}` // string, layer-3-denied — the full-record echo canary (PATCH)
const FLD_FORMULA = `fld_f3_formula_${TS}` // formula ={FLD_VISIBLE}+1, layer-3-denied — the computed echo (POST /patch)
const REC_ID = `rec_f3_${TS}`
const USER_ID = `u_f3_${TS}` // FLD_SECRET + FLD_FORMULA denied
const USER_ID_2 = `u_f3_other_${TS}` // no deny → positive control
const VISIBLE_INITIAL = 5
const SECRET_INITIAL = 'do-not-leak-f3-initial'

let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } = { id: USER_ID, roles: ['member'], perms: ['multitable:write'] }

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const patchReq = (recordId: string, body: Record<string, unknown>) =>
  request(app).patch(`/api/multitable/records/${recordId}`).send(body)
const batchPatch = (body: Record<string, unknown>) =>
  request(app).post('/api/multitable/patch').send(body)
const dbField = async (fieldId: string) => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [REC_ID])
  const data = (r.rows[0]?.data ?? {}) as Record<string, unknown>
  return data[fieldId]
}
const echoRec = (res: { body: { data?: { records?: Array<{ recordId: string; data: Record<string, unknown> }> } } }) =>
  res.body.data?.records?.find((r) => r.recordId === REC_ID)

describeIfDatabase('F3 write-echo field mask (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = currentUser; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'F3 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'F3 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VISIBLE, SHEET_ID, 'Visible', 'number', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRET, SHEET_ID, 'Secret', 'string', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_FORMULA, SHEET_ID, 'Derived', 'formula', JSON.stringify({ expression: `={${FLD_VISIBLE}}+1` }), 3])
    // Direct-SQL field insert bypasses the create-field path that normally records formula deps, so seed it
    // explicitly — recalculateFormulaFields gates on formula_dependencies (no row → no recompute → vacuous echo).
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)', [SHEET_ID, FLD_FORMULA, FLD_VISIBLE, SHEET_ID])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_ID, SHEET_ID, JSON.stringify({ [FLD_VISIBLE]: VISIBLE_INITIAL, [FLD_SECRET]: SECRET_INITIAL })])
    // layer-3 read deny (subject-scoped). property carries no hidden → deny is solely here.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER_ID, false, false])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_FORMULA, 'user', USER_ID, false, false])
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('R1 (PATCH bystander): editing a readable field still echoes the full record masked — a denied field is omitted', async () => {
    currentUser = { id: USER_ID, roles: ['member'], perms: ['multitable:write'] }
    const res = await patchReq(REC_ID, { sheetId: SHEET_ID, data: { [FLD_VISIBLE]: 10 } })
    expect(res.status).toBe(200)
    expect(res.body.data.record.data[FLD_VISIBLE]).toBe(10) // write applied + echoed (positive control)
    expect(res.body.data.record.data[FLD_SECRET]).toBeUndefined() // THE LEAK (RED pre-fix)
    expect(JSON.stringify(res.body)).not.toContain(SECRET_INITIAL)
  })

  test('R2 (PATCH write-only-no-read): PATCH a denied field itself → write PERSISTS but echo omits it', async () => {
    currentUser = { id: USER_ID, roles: ['member'], perms: ['multitable:write'] }
    const rewrite = `do-not-leak-f3-rewrite-${TS}`
    const res = await patchReq(REC_ID, { sheetId: SHEET_ID, data: { [FLD_SECRET]: rewrite } })
    expect(res.status).toBe(200) // writable: the write gate is layer-2, never field_permissions
    expect(res.body.data.record.data[FLD_SECRET]).toBeUndefined() // echo omits the value just written (RED pre-fix)
    expect(JSON.stringify(res.body)).not.toContain(rewrite)
    expect(await dbField(FLD_SECRET)).toBe(rewrite) // ...but the write really happened — mask is echo-only
  })

  test('R3 (POST /patch computed echo): a denied FORMULA value is masked from the records echo — positive control first', async () => {
    // POST /patch echoes only computed/dependent data (mergedRecords). Use the formula field so the
    // assertion is non-vacuous. Positive control FIRST: the ungranted user DOES receive the formula value.
    currentUser = { id: USER_ID_2, roles: ['member'], perms: ['multitable:write'] }
    const granted = await batchPatch({ sheetId: SHEET_ID, changes: [{ recordId: REC_ID, fieldId: FLD_VISIBLE, value: 20 }] })
    expect(granted.status).toBe(200)
    expect(echoRec(granted)?.data?.[FLD_FORMULA]).toBeDefined() // proves the echo channel carries the formula value

    currentUser = { id: USER_ID, roles: ['member'], perms: ['multitable:write'] }
    const denied = await batchPatch({ sheetId: SHEET_ID, changes: [{ recordId: REC_ID, fieldId: FLD_VISIBLE, value: 30 }] })
    expect(denied.status).toBe(200)
    expect(echoRec(denied)?.data?.[FLD_FORMULA]).toBeUndefined() // THE LEAK (RED pre-fix, GREEN post-fix)
  })

  test('R5 (positive): an ungranted-to-deny user still gets the denied field in the PATCH echo (mask is per-subject)', async () => {
    currentUser = { id: USER_ID_2, roles: ['member'], perms: ['multitable:write'] }
    const res = await patchReq(REC_ID, { sheetId: SHEET_ID, data: { [FLD_VISIBLE]: 40 } })
    expect(res.status).toBe(200)
    expect(res.body.data.record.data[FLD_SECRET]).toBe(await dbField(FLD_SECRET)) // present, equals persisted value
    currentUser = { id: USER_ID, roles: ['member'], perms: ['multitable:write'] }
  })
})
