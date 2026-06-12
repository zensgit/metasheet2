/**
 * §2a.3 sibling raw-read/emit sinks (delta-review MAJOR M1-READ + exhaustive sweep) — "the read
 * taint-drop covered only GET /view; the materialized formula value still leaks through every other
 * endpoint that emits meta_records.data raw".
 *
 * Formula values are materialized into meta_records.data. GET /view drops tainted formula ids from
 * its allowed-field set, but the SIBLING read/emit paths build the SAME #2015 layer-2 ∧ layer-3
 * composite (and their own comments claim "/view parity") WITHOUT the taint drop, so a formula over
 * a denied cross-base lookup — source-visible, foreign-input-denied — flows straight to the wire:
 *
 *   - single-record GET   (GET /records/:id)          → data.record.data[FormulaCol]  (M1-READ)
 *   - cursor list          (GET /records)              → records[].data[FormulaCol]    (M1-READ)
 *   - PATCH echo           (PATCH /records/:id)        → data.record.data[FormulaCol]  (sweep)
 *   - form edit-mode echo  (GET /form-context?recordId)→ data.record.data[FormulaCol]  (sweep)
 *   - dashboard group-by   (POST /dashboard/query)     → points[].label == formula value (sweep)
 *
 * Contract (§2a.3, taint-uniform): the SAME resolveTaintedFormulaFieldIds that masks /view + export
 * + aggregate must drop the tainted formula column on EVERY raw read/emit sink, for the requesting
 * actor. ALLOW controls (no foreign-field denial) must still see the value (non-vacuous).
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
const DENY_USER = `u_frd_${TS}` // denied on the cross-base foreign target
const ALLOW_USER = `u_fra_${TS}` // no field denial → sees the formula value

const BASE_A = `base_fr_a_${TS}`
const BASE_B = `base_fr_b_${TS}`
const FS_X = `sheet_fr_fx_${TS}` // cross-base foreign sheet (BASE_B)
const MS = `sheet_fr_main_${TS}` // main source sheet (BASE_A)
const V_FORM = `v_fr_form_${TS}` // form view over MS (edit-mode form-context)

const FLD_XTARGET = `fld_fr_xt_${TS}` // cross-base foreign target (denied for DENY_USER)
const FLD_LINK = `fld_fr_lk_${TS}`
const FLD_LU = `fld_fr_lu_${TS}` // lookup over the cross-base target
const FLD_F = `fld_fr_f_${TS}` // formula = {lookup}+1, materialized = 8
const FLD_PLAIN = `fld_fr_p_${TS}` // a plain readable column (PATCH target / control)

const REC_FX = `rec_fr_fx_${TS}` // XTARGET = 7
const REC_M1 = `rec_fr_m1_${TS}` // formula materialized = 8
const REC_M2 = `rec_fr_m2_${TS}` // formula materialized = 8 (second cursor row)

const FORMULA_VALUE = 8 // = lookup 7 + 1, pre-materialized into data

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).user = {
      id: userId,
      roles: ['member'],
      perms: ['multitable:read', 'multitable:write'],
      permissions: ['multitable:read', 'multitable:write'],
    }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}

async function seedMainRecord(recordId: string) {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
    recordId,
    MS,
    JSON.stringify({ [FLD_LINK]: [REC_FX], [FLD_F]: FORMULA_VALUE, [FLD_PLAIN]: 'visible' }),
  ])
  await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [
    `lnk_fr_${recordId}`,
    FLD_LINK,
    recordId,
    REC_FX,
  ])
}

describeIfDatabase('multitable formula-over-lookup foreign-field mask — sibling read/emit sinks (M1-READ + sweep, real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_A, 'FR Base A'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_B, 'FR Base B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FS_X, BASE_B, 'Cross Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [MS, BASE_A, 'Main Sheet'])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_XTARGET, FS_X, 'XTarget', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_FX, FS_X, JSON.stringify({ [FLD_XTARGET]: 7 })])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS_X }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LU, MS, 'Lookup', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_XTARGET, foreignSheetId: FS_X }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_F, MS, 'FormulaCol', 'formula', JSON.stringify({ expression: `={${FLD_LU}}+1` }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_PLAIN, MS, 'PlainCol', 'string', '{}', 4])

    await seedMainRecord(REC_M1)
    await seedMainRecord(REC_M2)

    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)',
      [MS, FLD_F, FLD_LU, MS])

    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [FS_X, FLD_XTARGET, 'user', DENY_USER, false, false])

    // Form view over MS (form-context edit-mode loads an existing record's data into the form echo).
    await q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [
      V_FORM, MS, 'FR Form', 'form', '[]', JSON.stringify({}),
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

  // M1-READ (single-record GET): DENY actor must NOT receive the materialized formula value.
  test('M1-READ: DENY single-record GET withholds the materialized formula value', async () => {
    const res = await request(buildApp(DENY_USER)).get(`/api/multitable/records/${REC_M1}`).query({ sheetId: MS })
    expect(res.status).toBe(200)
    expect(res.body?.data?.record?.data?.[FLD_F]).toBeUndefined()
    // the plain readable column is still present (mask is field-scoped, not whole-record).
    expect(res.body?.data?.record?.data?.[FLD_PLAIN]).toBe('visible')
  })

  test('M1-READ control: ALLOW single-record GET sees the materialized formula value', async () => {
    const res = await request(buildApp(ALLOW_USER)).get(`/api/multitable/records/${REC_M1}`).query({ sheetId: MS })
    expect(res.status).toBe(200)
    expect(res.body?.data?.record?.data?.[FLD_F]).toBe(FORMULA_VALUE)
  })

  // M1-READ (cursor list): DENY actor must NOT receive the materialized formula value on ANY row.
  test('M1-READ: DENY cursor /records withholds the materialized formula value', async () => {
    const res = await request(buildApp(DENY_USER)).get('/api/multitable/records').query({ sheetId: MS })
    expect(res.status).toBe(200)
    const records: Array<{ data?: Record<string, unknown> }> = res.body?.data?.records ?? []
    expect(records.length).toBeGreaterThan(0)
    for (const record of records) {
      expect(record.data?.[FLD_F]).toBeUndefined()
    }
  })

  test('M1-READ control: ALLOW cursor /records sees the materialized formula value', async () => {
    const res = await request(buildApp(ALLOW_USER)).get('/api/multitable/records').query({ sheetId: MS })
    expect(res.status).toBe(200)
    const records: Array<{ data?: Record<string, unknown> }> = res.body?.data?.records ?? []
    expect(records.some((record) => record.data?.[FLD_F] === FORMULA_VALUE)).toBe(true)
  })

  // Sweep (PATCH echo): a DENY actor editing the plain column gets the freshly-read record echoed
  // back; the re-read materialized formula value must NOT leak in that echo.
  test('sweep: DENY PATCH echo withholds the materialized formula value', async () => {
    const res = await request(buildApp(DENY_USER)).patch(`/api/multitable/records/${REC_M2}`).send({
      sheetId: MS,
      data: { [FLD_PLAIN]: 'edited' },
    })
    expect(res.status).toBe(200)
    expect(res.body?.data?.record?.data?.[FLD_F]).toBeUndefined()
    expect(res.body?.data?.record?.data?.[FLD_PLAIN]).toBe('edited')
  })

  test('sweep control: ALLOW PATCH echo sees the materialized formula value', async () => {
    const res = await request(buildApp(ALLOW_USER)).patch(`/api/multitable/records/${REC_M1}`).send({
      sheetId: MS,
      data: { [FLD_PLAIN]: 'edited2' },
    })
    expect(res.status).toBe(200)
    expect(res.body?.data?.record?.data?.[FLD_F]).toBe(FORMULA_VALUE)
  })

  // Sweep (form edit-mode echo): a DENY actor loading an existing record into the form must NOT get
  // the materialized formula value prefilled.
  test('sweep: DENY form-context edit-mode echo withholds the materialized formula value', async () => {
    const res = await request(buildApp(DENY_USER))
      .get('/api/multitable/form-context')
      .query({ sheetId: MS, viewId: V_FORM, recordId: REC_M1 })
    expect(res.status).toBe(200)
    expect(res.body?.data?.record?.data?.[FLD_F]).toBeUndefined()
  })

  test('sweep control: ALLOW form-context edit-mode echo sees the materialized formula value', async () => {
    const res = await request(buildApp(ALLOW_USER))
      .get('/api/multitable/form-context')
      .query({ sheetId: MS, viewId: V_FORM, recordId: REC_M1 })
    expect(res.status).toBe(200)
    expect(res.body?.data?.record?.data?.[FLD_F]).toBe(FORMULA_VALUE)
  })

  // Sweep (dashboard group-by): grouping a count widget by the formula column exposes the formula
  // value as a bucket label. A DENY actor must NOT see the value (all rows collapse to one
  // empty/absent bucket); an ALLOW actor sees a bucket labelled with the value.
  test('sweep: DENY dashboard group-by does NOT leak the formula value as a bucket label', async () => {
    const res = await request(buildApp(DENY_USER)).post('/api/multitable/dashboard/query').send({
      sheetId: MS,
      widgets: [{ title: 'By Formula', chartType: 'bar', groupByFieldId: FLD_F, metric: 'count' }],
    })
    expect(res.status).toBe(200)
    const points: Array<{ key?: unknown; label?: unknown }> = res.body?.data?.widgets?.[0]?.points ?? []
    const leaks = points.some((point) => String(point.key) === String(FORMULA_VALUE) || String(point.label) === String(FORMULA_VALUE))
    expect(leaks).toBe(false)
  })

  test('sweep control: ALLOW dashboard group-by exposes the formula value as a bucket label', async () => {
    const res = await request(buildApp(ALLOW_USER)).post('/api/multitable/dashboard/query').send({
      sheetId: MS,
      widgets: [{ title: 'By Formula', chartType: 'bar', groupByFieldId: FLD_F, metric: 'count' }],
    })
    expect(res.status).toBe(200)
    const points: Array<{ key?: unknown; label?: unknown }> = res.body?.data?.widgets?.[0]?.points ?? []
    const exposes = points.some((point) => String(point.key) === String(FORMULA_VALUE) || String(point.label) === String(FORMULA_VALUE))
    expect(exposes).toBe(true)
  })
})
