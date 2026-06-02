/**
 * Real-DB integration test for D1 — the form-context / form-submit echo field mask.
 * Design-lock: docs/development/multitable-form-context-submit-field-mask-design-20260602.md.
 *
 * `GET /form-context?recordId=` and `POST /views/:viewId/submit` echo `record.data`, but mask it by
 * `visible*FieldIds` = layer-1 (view.hidden) ∧ layer-2 (`property.hidden`) ONLY — they do NOT apply the
 * subject-scoped layer-3 (`field_permissions.visible`) gate that `/view` + `/records/:id` (#2028) enforce.
 * So an AUTHENTICATED, field-denied caller can read a denied field's value through these two paths.
 * (Public/anonymous callers are moot: no subject → no field_permissions deny applies, and public can't
 * load/update existing records — @6735/@6902 → 400.)
 *
 * D1 verdict: anonymous = no subject (mask is a strict no-op); IDENTIFIED = must apply layer-3; context-echo
 * and submit-echo judged the SAME. Fix = mask the echo by the layer-2 ∧ layer-3 composite (#2015), keyed to
 * the requester. The submit-echo carries the F3/F4 subtleties: a denied field the submitter did NOT send
 * (server-assigned / recalculated formula) is the unambiguous create-echo canary (C4).
 *
 * Seed non-negotiable: denied fields' property carries no `hidden` → deny is solely layer-3.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_d1_${TS}`
const SHEET_ID = `sheet_d1_${TS}`
const VIEW_ID = `view_d1_${TS}`
const FLD_VISIBLE = `fld_d1_vis_${TS}` // readable — positive control + the bystander edit target
const FLD_SECRET = `fld_d1_secret_${TS}` // string, layer-3-denied to USER — the read/update echo canary
const FLD_FORMULA = `fld_d1_formula_${TS}` // formula ={FLD_VISIBLE}+1, layer-3-denied — the server-assigned create-echo canary
const REC_ID = `rec_d1_${TS}`
const USER_ID = `u_d1_${TS}` // denied FLD_SECRET + FLD_FORMULA
const USER_ID_2 = `u_d1_other_${TS}` // no deny — positive control
const PUBLIC_TOKEN = `tok_d1_${TS}`
const SECRET_CANARY = `do-not-leak-d1-${TS}`

let app: Express
let testUserId: string | null = USER_ID
let testPerms: string[] = ['multitable:read', 'multitable:write']

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const formContext = (recordId?: string) =>
  request(app).get('/api/multitable/form-context').query({ sheetId: SHEET_ID, viewId: VIEW_ID, ...(recordId ? { recordId } : {}) })
const submit = (body: Record<string, unknown>, publicToken?: string) => {
  let r = request(app).post(`/api/multitable/views/${VIEW_ID}/submit`)
  if (publicToken) r = r.query({ publicToken })
  return r.send(body)
}

describeIfDatabase('D1 form-context / form-submit echo field mask (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'D1 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'D1 Sheet'])
    // a 'form' view with a public-form config (so the anonymous path C6 is reachable)
    await q(
      'INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
      [VIEW_ID, SHEET_ID, 'D1 Form', 'form', '[]', JSON.stringify({ publicForm: { enabled: true, publicToken: PUBLIC_TOKEN, accessMode: 'public' } })],
    )
    // all fields property '{}' → no layer-2 hidden; deny is solely layer-3
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VISIBLE, SHEET_ID, 'Visible', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRET, SHEET_ID, 'Secret', 'string', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_FORMULA, SHEET_ID, 'Derived', 'formula', JSON.stringify({ expression: `={${FLD_VISIBLE}}+1` }), 3])
    // direct-SQL field insert skips the create path that records formula deps → seed it (recalc gates on it)
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)', [SHEET_ID, FLD_FORMULA, FLD_VISIBLE, SHEET_ID])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_ID, SHEET_ID, JSON.stringify({ [FLD_VISIBLE]: 'v0', [FLD_SECRET]: SECRET_CANARY })])
    // layer-3 read deny on FLD_SECRET + FLD_FORMULA for USER only (USER_2 = positive control)
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER_ID, false, false])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_FORMULA, 'user', USER_ID, false, false])
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM formula_dependencies WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('C1 (form-context recordId, USER): a denied field value is omitted from the loaded record echo', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read', 'multitable:write']
    const res = await formContext(REC_ID)
    expect(res.status).toBe(200)
    expect(res.body.data.record.data[FLD_VISIBLE]).toBe('v0') // positive control: readable value present
    expect(res.body.data.record.data[FLD_SECRET]).toBeUndefined() // THE LEAK (RED pre-fix)
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY)
  })

  test('C2 (form-context recordId, USER_2 positive): an ungranted-to-deny user DOES get the value (per-subject)', async () => {
    testUserId = USER_ID_2; testPerms = ['multitable:read', 'multitable:write']
    const res = await formContext(REC_ID)
    expect(res.status).toBe(200)
    expect(res.body.data.record.data[FLD_SECRET]).toBe(SECRET_CANARY)
    testUserId = USER_ID
  })

  test('C3 (submit UPDATE echo, USER): a denied pre-existing field is omitted from the write echo', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read', 'multitable:write']
    // edit only the readable bystander field; FLD_SECRET is NOT submitted but is resurfaced server-side in the echo
    const res = await submit({ recordId: REC_ID, data: { [FLD_VISIBLE]: 'v1' } })
    expect(res.status).toBe(200)
    expect(res.body.data.record.data[FLD_VISIBLE]).toBe('v1') // positive control: write applied + echoed
    expect(res.body.data.record.data[FLD_SECRET]).toBeUndefined() // THE LEAK (RED pre-fix)
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY)
  })

  test('C4 (submit CREATE echo, USER): a denied SERVER-ASSIGNED (recalculated formula) field is omitted', async () => {
    // the unambiguous create canary (F4-style): the submitter never sends FLD_FORMULA — the server computes it,
    // so its presence in the echo cannot be a "user submitted it" artifact.
    testUserId = USER_ID; testPerms = ['multitable:read', 'multitable:write']
    const res = await submit({ data: { [FLD_VISIBLE]: '42' } })
    expect(res.status).toBe(200)
    expect(res.body.data.record.data[FLD_VISIBLE]).toBe('42') // positive control
    expect(res.body.data.record.data[FLD_FORMULA]).toBeUndefined() // THE LEAK (RED pre-fix): denied server-assigned value
  })

  test('C5 (submit CREATE echo, USER_2 positive): the formula echo channel DOES carry the value (non-vacuous)', async () => {
    testUserId = USER_ID_2; testPerms = ['multitable:read', 'multitable:write']
    const res = await submit({ data: { [FLD_VISIBLE]: '42' } })
    expect(res.status).toBe(200)
    expect(res.body.data.record.data[FLD_FORMULA]).not.toBeUndefined() // proves C4's absence is a real mask, not an empty channel
    testUserId = USER_ID
  })

  test('C6 (anonymous public CREATE): the fix is a NO-OP for an anonymous caller (no subject → moot)', async () => {
    // proves the framing: anonymous has no field_permissions subject, so the layer-3 mask adds nothing and the
    // pre-existing layer-1∧2 behavior is unchanged — the denied-to-USER formula field is STILL echoed here.
    testUserId = null
    const res = await submit({ publicToken: PUBLIC_TOKEN, data: { [FLD_VISIBLE]: '7' } }, PUBLIC_TOKEN)
    expect(res.status).toBe(200)
    expect(res.body.data.record.data[FLD_FORMULA]).not.toBeUndefined() // anonymous: USER's deny does not apply → unchanged
    testUserId = USER_ID
  })
})
