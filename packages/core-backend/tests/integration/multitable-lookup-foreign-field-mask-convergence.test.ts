/**
 * §2a.3 CONVERGENCE canaries (4th-round review, commit 96dfddbca) — the two stored-`data` read
 * sinks the prior rounds left uncovered, plus the ALLOW controls that prove no over-suppression.
 *
 * A formula value is materialized into meta_records.data. Every surface that re-reads that stored
 * data under a SOURCE-SHEET-ONLY field mask must drop the tainted formula (a formula whose value
 * derives from a lookup/rollup over a foreign field DENIED to the actor) via the centralized
 * chokepoint. The prior rounds proved single-GET / cursor / PATCH-echo / form-CONTEXT echo /
 * aggregate / dashboard / history. This file locks the last two:
 *
 *   C1 (BLOCKER): POST /views/:id/submit in EDIT mode (body has `recordId`) re-reads the existing
 *     record's stored data; the taint-SKIPPED create recompute never overwrites a tainted formula,
 *     so a previously-materialized AUTHORIZED value would survive into the echo to a
 *     foreign-field-denied (often anonymous) submitter. Must be `undefined` for DENY, stored for ALLOW.
 *
 *   C2 (MAJOR): GET /records-summary accepts an attacker-chosen `displayFieldId`. A formula over a
 *     denied lookup is source-visible, so a denied actor could request it as the display and read the
 *     string-coerced materialized value. Must be rejected (400) for DENY, projected for ALLOW.
 *
 * Real DB (describeIfDatabase). Drives the actual wires.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const DENY_USER = `u_cvg_d_${TS}` // denied on the cross-base foreign target
const ALLOW_USER = `u_cvg_a_${TS}` // no field denial → sees the formula value

const BASE_A = `base_cvg_a_${TS}`
const BASE_B = `base_cvg_b_${TS}`
const FS_X = `sheet_cvg_fx_${TS}` // cross-base foreign sheet (BASE_B)
const MS = `sheet_cvg_main_${TS}` // main source sheet (BASE_A)
const V_FORM = `v_cvg_form_${TS}` // form view over MS (edit-mode submit)

const FLD_XTARGET = `fld_cvg_xt_${TS}` // cross-base foreign target (denied for DENY_USER)
const FLD_LINK = `fld_cvg_lk_${TS}`
const FLD_LU = `fld_cvg_lu_${TS}` // lookup over the cross-base target
const FLD_F = `fld_cvg_f_${TS}` // formula = {lookup}+1, materialized = 8
const FLD_PLAIN = `fld_cvg_p_${TS}` // a plain readable column (submit-edit target / control)

const REC_FX = `rec_cvg_fx_${TS}` // XTARGET = 7
const REC_M1 = `rec_cvg_m1_${TS}` // formula materialized = 8

const FORMULA_VALUE = 8 // = lookup 7 + 1, pre-materialized into data

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).user = {
      id: userId,
      roles: ['member'],
      // ②b: foreign sheet is cross-base; grant `multitable:base:read` so the actor clears the new §3.2
      // coarse base-read gate and this suite keeps isolating FIELD-level masking (DENY cases stay masked
      // by the field gate). Base-gate axis covered by XB-2* in multitable-cross-base-link-optin.test.ts.
      perms: ['multitable:read', 'multitable:write', 'multitable:base:read'],
      permissions: ['multitable:read', 'multitable:write', 'multitable:base:read'],
    }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}

describeIfDatabase('§2a.3 convergence — form-submit EDIT echo (C1) + records-summary displayFieldId (C2) (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_A, 'CVG Base A'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_B, 'CVG Base B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FS_X, BASE_B, 'CVG Cross Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [MS, BASE_A, 'CVG Main Sheet'])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_XTARGET, FS_X, 'XTarget', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_FX, FS_X, JSON.stringify({ [FLD_XTARGET]: 7 })])

    // PLAIN ordered FIRST so /records-summary auto-pick prefers it (string) — C2's leak requires an
    // EXPLICIT displayFieldId pointing at the formula, never the auto-pick default.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_PLAIN, MS, 'PlainCol', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS_X }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LU, MS, 'Lookup', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_XTARGET, foreignSheetId: FS_X }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_F, MS, 'FormulaCol', 'formula', JSON.stringify({ expression: `={${FLD_LU}}+1` }), 4])

    // Existing main record with FLD_F pre-materialized to 8 (a prior AUTHORIZED write).
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      REC_M1,
      MS,
      JSON.stringify({ [FLD_LINK]: [REC_FX], [FLD_F]: FORMULA_VALUE, [FLD_PLAIN]: 'visible' }),
    ])
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [
      `lnk_cvg_${REC_M1}`,
      FLD_LINK,
      REC_M1,
      REC_FX,
    ])

    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)',
      [MS, FLD_F, FLD_LU, MS])

    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [FS_X, FLD_XTARGET, 'user', DENY_USER, false, false])

    // Form view over MS — submit in EDIT mode (body carries recordId) re-reads the stored record.
    await q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [
      V_FORM, MS, 'CVG Form', 'form', '[]', JSON.stringify({}),
    ])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [MS]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[FS_X, MS]]).catch(() => {})
    await q('DELETE FROM formula_dependencies WHERE sheet_id = $1', [MS]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS_X]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS_X]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS_X]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // ---- C1: form-submit EDIT echo --------------------------------------------------------------
  test('C1: DENY form-submit EDIT echo withholds the materialized formula value', async () => {
    const res = await request(buildApp(DENY_USER))
      .post(`/api/multitable/views/${V_FORM}/submit`)
      .send({ recordId: REC_M1, data: { [FLD_PLAIN]: 'edited' } })
    expect(res.status).toBe(200)
    expect(res.body?.data?.record?.data?.[FLD_F]).toBeUndefined()
    // the plain readable column still round-trips (mask is field-scoped, not whole-record).
    expect(res.body?.data?.record?.data?.[FLD_PLAIN]).toBe('edited')
  })

  test('C1 control: ALLOW form-submit EDIT echo sees the materialized formula value', async () => {
    const res = await request(buildApp(ALLOW_USER))
      .post(`/api/multitable/views/${V_FORM}/submit`)
      .send({ recordId: REC_M1, data: { [FLD_PLAIN]: 'edited-allow' } })
    expect(res.status).toBe(200)
    expect(res.body?.data?.record?.data?.[FLD_F]).toBe(FORMULA_VALUE)
  })

  // ---- C2: records-summary attacker-chosen displayFieldId -------------------------------------
  test('C2: DENY records-summary with explicit formula displayFieldId is rejected and leaks no value', async () => {
    const res = await request(buildApp(DENY_USER))
      .get('/api/multitable/records-summary')
      .query({ sheetId: MS, displayFieldId: FLD_F })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).not.toContain(String(FORMULA_VALUE))
  })

  test('C2 control: ALLOW records-summary with explicit formula displayFieldId projects the value', async () => {
    const res = await request(buildApp(ALLOW_USER))
      .get('/api/multitable/records-summary')
      .query({ sheetId: MS, displayFieldId: FLD_F })
    expect(res.status).toBe(200)
    const records: Array<{ id?: string; display?: string }> = res.body?.data?.records ?? []
    expect(records.some((r) => r.display === String(FORMULA_VALUE))).toBe(true)
  })
})
