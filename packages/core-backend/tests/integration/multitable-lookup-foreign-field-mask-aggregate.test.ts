/**
 * §2a.3 raw-read sinks (M1 review MAJOR + read/JSON probe) — "materialized formula values over a
 * denied lookup leak through view-aggregate and the plain records read path".
 *
 * Formula values ARE materialized into meta_records.data. Both `view-aggregate` and the main
 * /view records read path read those values RAW (view-aggregate never calls applyLookupRollup;
 * the read path calls it but only to mask the LOOKUP column — the materialized FORMULA column is
 * read straight from data). A formula over a denied cross-base lookup passes the source-sheet
 * field gate (the formula field itself is not denied) and leaks:
 *   - view-aggregate: via count/countDistinct/countNonEmpty (cardinality / non-emptiness over the
 *     denied-derived column).
 *   - /view: the materialized value itself in row.data.
 *
 * Contract (§2a.3, taint-uniform): the SAME taint resolver that drops tainted formula columns from
 * export must also drop them from aggregate output AND from the read/JSON row data, for the
 * requesting actor.
 *
 * Real DB (describeIfDatabase). Drives the actual view-aggregate + /view wires.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const DENY_USER = `u_fad_${TS}` // denied on the cross-base foreign target
const ALLOW_USER = `u_faa_${TS}` // no field denial → sees the formula aggregate/value

const BASE_A = `base_fa_a_${TS}`
const BASE_B = `base_fa_b_${TS}`
const FS_X = `sheet_fa_fx_${TS}` // cross-base foreign sheet (BASE_B)
const MS = `sheet_fa_main_${TS}` // main source sheet (BASE_A)

const FLD_XTARGET = `fld_fa_xt_${TS}` // cross-base foreign target (denied for DENY_USER)
const FLD_LINK = `fld_fa_lk_${TS}`
const FLD_LU = `fld_fa_lu_${TS}` // lookup over the cross-base target
const FLD_F = `fld_fa_f_${TS}` // formula = {lookup}+1, materialized
const FLD_PLAIN = `fld_fa_p_${TS}` // a plain readable column (control)

const V_AGG = `v_fa_agg_${TS}` // aggregates countNonEmpty(formula) + count(plain)

let app: Express
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).user = { id: userId, roles: ['member'], perms: ['multitable:read'], permissions: ['multitable:read'] }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}

describeIfDatabase('multitable formula-over-lookup foreign-field mask — aggregate + read (M1 + probe, real DB)', () => {
  beforeAll(async () => {
    app = buildApp(DENY_USER)

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_A, 'FA Base A'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_B, 'FA Base B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FS_X, BASE_B, 'Cross Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [MS, BASE_A, 'Main Sheet'])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_XTARGET, FS_X, 'XTarget', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [`rec_fa_fx_${TS}`, FS_X, JSON.stringify({ [FLD_XTARGET]: 7 })])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS_X }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LU, MS, 'Lookup', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_XTARGET, foreignSheetId: FS_X }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_F, MS, 'FormulaCol', 'formula', JSON.stringify({ expression: `={${FLD_LU}}+1` }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_PLAIN, MS, 'PlainCol', 'string', '{}', 4])

    // Two records — both have a MATERIALIZED non-empty formula value (8) over the denied lookup.
    // countNonEmpty(FormulaCol) = 2 if the column leaks; the taint fix must omit the aggregate.
    for (const [rid, lnk] of [
      [`rec_fa_m1_${TS}`, `rec_fa_fx_${TS}`],
      [`rec_fa_m2_${TS}`, `rec_fa_fx_${TS}`],
    ]) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
        [rid, MS, JSON.stringify({ [FLD_LINK]: [lnk], [FLD_F]: 8, [FLD_PLAIN]: 'visible' })])
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
        [`lnk_fa_${rid}`, FLD_LINK, rid, lnk])
    }

    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)',
      [MS, FLD_F, FLD_LU, MS])

    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [FS_X, FLD_XTARGET, 'user', DENY_USER, false, false])

    // view aggregating countNonEmpty over the formula column + count over a plain column (control).
    await q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, filter_info, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)', [
      V_AGG, MS, 'AggView', 'grid', '[]', JSON.stringify({ conjunction: 'and', conditions: [] }),
      JSON.stringify({ aggregations: { [FLD_F]: 'countNonEmpty', [FLD_PLAIN]: 'count' } }),
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

  // M1: DENY actor aggregating countNonEmpty over a formula-over-denied-cross-base-lookup column →
  // the tainted formula aggregate is OMITTED (no count/cardinality leak). The plain control survives.
  test('M1: DENY actor view-aggregate omits the tainted formula column aggregate', async () => {
    const res = await request(buildApp(DENY_USER)).get(`/api/multitable/sheets/${MS}/view-aggregate?viewId=${V_AGG}`)
    expect(res.status).toBe(200)
    const aggregates = res.body?.data?.aggregates ?? {}
    expect(aggregates[FLD_F]).toBeUndefined() // tainted formula aggregate omitted (no leak)
    expect(aggregates[FLD_PLAIN]).toBeDefined() // plain control still aggregated
    expect(aggregates[FLD_PLAIN].value).toBe(2)
  })

  // Control: ALLOW actor (no field denial) still gets the formula aggregate.
  test('M1 control: ALLOW actor view-aggregate includes the formula column aggregate', async () => {
    const res = await request(buildApp(ALLOW_USER)).get(`/api/multitable/sheets/${MS}/view-aggregate?viewId=${V_AGG}`)
    expect(res.status).toBe(200)
    const aggregates = res.body?.data?.aggregates ?? {}
    expect(aggregates[FLD_F]).toBeDefined()
    expect(aggregates[FLD_F].value).toBe(2) // countNonEmpty over both materialized 8s
  })

  // PROBE (read/JSON): DENY actor reading the records via /view — does the materialized formula
  // value (8) leak straight from data? It must NOT (tainted formula column masked uniformly).
  test('probe: DENY actor /view does NOT leak the materialized formula value', async () => {
    const res = await request(buildApp(DENY_USER)).get(`/api/multitable/view?sheetId=${MS}`)
    expect(res.status).toBe(200)
    const rows: Array<{ data?: Record<string, unknown> }> = res.body?.data?.rows ?? []
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.data?.[FLD_F]).toBeUndefined() // tainted formula column masked on read/JSON
    }
  })

  // Control: ALLOW actor reading via /view DOES see the materialized formula value.
  test('probe control: ALLOW actor /view sees the materialized formula value', async () => {
    const res = await request(buildApp(ALLOW_USER)).get(`/api/multitable/view?sheetId=${MS}`)
    expect(res.status).toBe(200)
    const rows: Array<{ data?: Record<string, unknown> }> = res.body?.data?.rows ?? []
    expect(rows.some((row) => row.data?.[FLD_F] === 8)).toBe(true)
  })
})
