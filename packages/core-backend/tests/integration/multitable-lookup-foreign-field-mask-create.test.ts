/**
 * §2a.3 write-sink B1-CREATE (delta-review BLOCKER) — "a denied CREATE / public form-submit must
 * not persist a permission-degraded formula value into shared meta_records.data".
 *
 * The PATCH recompute (`recalculateFormulaFields`) was given a write-side taint skip, but the
 * CREATE / import / public-form-submit recompute is a DIFFERENT function (`recalcNewRecordFormulas`)
 * that hydrates the new row via `applyLookupRollup` (MASKED for the creating actor → lookup []) and
 * then recomputes ALL formulas against that masked input, persisting them via
 * `recalculateRecordFromData` (UPDATE meta_records SET data = data || $patch). So a foreign-field-
 * DENIED creator stores `{}+1 = 1` instead of the authorized `lookup 9 + 1 = 10`, and every
 * privileged reader then sees `1`.
 *
 * Severity is higher than the original PATCH B1: `recalcNewRecordFormulas` is ALSO the PUBLIC
 * form-submit recompute, so an anonymous / low-privilege submitter (virtually always foreign-field-
 * denied) can corrupt shared formula state for privileged readers.
 *
 * Invariant under test: a foreign-field-DENIED create (authenticated POST /records OR public
 * form-submit) must NOT persist the masked formula value (1). The fix is the symmetric write-side
 * taint skip inside `recalcNewRecordFormulas`: tainted formulas are NOT recomputed on create, so
 * the column is left absent rather than degraded. An AUTHORIZED create still recomputes correctly
 * (10) — proving no over-suppression.
 *
 * Real DB (describeIfDatabase). Drives the actual POST /api/multitable/records +
 * POST /api/multitable/views/:viewId/submit (public) wires.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const DENY_USER = `u_fcd_${TS}` // denied on the cross-base foreign target field
const ALLOW_USER = `u_fca_${TS}` // no field denial → authorized truth

const BASE_A = `base_fc_a_${TS}`
const BASE_B = `base_fc_b_${TS}`
const FS_X = `sheet_fc_fx_${TS}` // cross-base foreign sheet (BASE_B)
const MS = `sheet_fc_main_${TS}` // main source sheet (BASE_A)
const V_FORM = `v_fc_form_${TS}` // public form view over MS
const PUBLIC_TOKEN = `pt_fc_${TS}`

const FLD_XTARGET = `fld_fc_xt_${TS}` // cross-base foreign target (denied for DENY_USER)
const FLD_LINK = `fld_fc_lk_${TS}`
const FLD_LU = `fld_fc_lu_${TS}` // lookup over the cross-base target
const FLD_F = `fld_fc_f_${TS}` // formula = {lookup}+1
const FLD_PLAIN = `fld_fc_p_${TS}` // a plain readable column (always submitted)

const REC_FY = `rec_fc_fy_${TS}` // XTARGET = 9 → authorized formula = 10

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string | null): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    if (userId) {
      ;(req as any).user = {
        id: userId,
        roles: ['member'],
        // ②b: foreign sheet is cross-base; grant `multitable:base:read` so the actor clears the new
        // §3.2 coarse base-read gate and this suite keeps isolating FIELD-level masking (DENY cases stay
        // masked by the field gate). Base-gate axis covered by XB-2* in the cross-base-link-optin suite.
        perms: ['multitable:read', 'multitable:write', 'multitable:base:read'],
        permissions: ['multitable:read', 'multitable:write', 'multitable:base:read'],
      }
    }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}

// Read the freshly-created record's stored (shared) formula value directly from the DB — this is
// the value every PRIVILEGED reader would see, independent of the creator's masked echo.
const readStoredFormula = async (recordId: string) => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, MS])
  const data = (r.rows as any[])[0]?.data
  const parsed = typeof data === 'string' ? JSON.parse(data) : data
  return parsed?.[FLD_F]
}

const latestRecordIdByPlain = async (plain: string) => {
  const r = await q(
    `SELECT id FROM meta_records WHERE sheet_id = $1 AND data ->> $2 = $3 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [MS, FLD_PLAIN, plain],
  )
  return (r.rows as any[])[0]?.id as string | undefined
}

describeIfDatabase('multitable formula-over-lookup foreign-field mask — create / form-submit corruption (B1-CREATE, real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_A, 'FC Base A'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_B, 'FC Base B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FS_X, BASE_B, 'Cross Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [MS, BASE_A, 'Main Sheet'])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_XTARGET, FS_X, 'XTarget', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_FY, FS_X, JSON.stringify({ [FLD_XTARGET]: 9 })])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS_X }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LU, MS, 'Lookup', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_XTARGET, foreignSheetId: FS_X }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_F, MS, 'FormulaCol', 'formula', JSON.stringify({ expression: `={${FLD_LU}}+1` }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_PLAIN, MS, 'PlainCol', 'string', '{}', 4])

    // formula depends on the lookup field (same sheet) — the taint edge.
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)',
      [MS, FLD_F, FLD_LU, MS])

    // field-level DENY for DENY_USER on the cross-base foreign target only.
    await q(
      'INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [FS_X, FLD_XTARGET, 'user', DENY_USER, false, false],
    )

    // Public form view over MS (used to drive the anonymous/denied public-form-submit recompute path).
    await q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [
      V_FORM, MS, 'FC Form', 'form', '[]',
      JSON.stringify({ publicForm: { enabled: true, publicToken: PUBLIC_TOKEN, accessMode: 'public' } }),
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

  // Control: an AUTHORIZED creator linking to FY(9) MUST persist the recomputed formula 10 (lookup
  // 9 + 1). Proves the create-path recompute fires AND the write-side taint skip does NOT
  // over-suppress an authorized create.
  test('control: AUTHORIZED create recomputes and persists the formula to authorized truth (10)', async () => {
    const PLAIN = `ctrl_allow_${TS}`
    const res = await request(buildApp(ALLOW_USER)).post('/api/multitable/records').send({
      sheetId: MS,
      data: { [FLD_LINK]: [REC_FY], [FLD_PLAIN]: PLAIN },
    })
    expect(res.status).toBe(200)
    const recordId = await latestRecordIdByPlain(PLAIN)
    expect(recordId).toBeTruthy()
    expect(await readStoredFormula(recordId!)).toBe(10)
  })

  // B1-CREATE BLOCKER: a DENIED creator issues the IDENTICAL create. Pre-fix the masked lookup
  // []→{}+1 = 1 is persisted into shared state (every privileged reader sees 1). The invariant: the
  // shared stored formula MUST NOT be the masked value 1 (the tainted formula is skipped on create).
  test('B1-CREATE: DENIED authenticated create does NOT persist the masked formula value (1)', async () => {
    const PLAIN = `b1_deny_${TS}`
    const res = await request(buildApp(DENY_USER)).post('/api/multitable/records').send({
      sheetId: MS,
      data: { [FLD_LINK]: [REC_FY], [FLD_PLAIN]: PLAIN },
    })
    expect(res.status).toBe(200)
    const recordId = await latestRecordIdByPlain(PLAIN)
    expect(recordId).toBeTruthy()
    // The denied creator must NOT have written the permission-degraded formula value into shared state.
    expect(await readStoredFormula(recordId!)).not.toBe(1)
  })

  // B1-CREATE (public form-submit reach): the SAME recalcNewRecordFormulas runs for public
  // form-submit, where the submitter is the foreign-field-denied actor. A denied public submit must
  // likewise NOT persist the masked formula value into shared state.
  test('B1-CREATE: DENIED public form-submit does NOT persist the masked formula value (1)', async () => {
    const PLAIN = `b1_pub_${TS}`
    const res = await request(buildApp(DENY_USER))
      .post(`/api/multitable/views/${V_FORM}/submit`)
      .query({ publicToken: PUBLIC_TOKEN })
      .send({ data: { [FLD_LINK]: [REC_FY], [FLD_PLAIN]: PLAIN } })
    expect(res.status).toBe(200)
    const recordId = await latestRecordIdByPlain(PLAIN)
    expect(recordId).toBeTruthy()
    expect(await readStoredFormula(recordId!)).not.toBe(1)
  })
})
