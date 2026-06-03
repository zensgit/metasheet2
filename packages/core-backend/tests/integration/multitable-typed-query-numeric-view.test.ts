/**
 * Slice 1 (typed query polish) real-DB wire proof. The unit matrix
 * (tests/unit/multitable-typed-query-numeric.test.ts) proves the helpers; this
 * proves a currency field's `type` actually reaches the in-memory comparator +
 * filter evaluator through the real GET /view handler (wire-vs-fixture-drift
 * guard), and that GET /view-aggregate agrees on the filtered set.
 *
 * Runs only with DATABASE_URL (describeIfDatabase) via the plugin-tests.yml step.
 * See docs/development/multitable-typed-query-polish-design-20260603.md §7 (Bar B).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const USER = `u_tqp_${TS}`
const BASE_ID = `base_tqp_${TS}`
const SHEET_ID = `sheet_tqp_${TS}`
const FLD_CUR = `fld_cur_${TS}`
const V_SORT = `v_sort_${TS}`
const V_FILTER = `v_filter_${TS}`

// Currency values chosen so lexicographic / localeCompare(numeric:true) ordering
// would DIFFER from numeric: "1.5" vs "1.25" (frac runs 5 vs 25) and the negative -5.
const VALUES = [10, 2, 1.5, 1.25, -5]
const ASC = [-5, 1.25, 1.5, 2, 10]

let app: Express
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

describeIfDatabase('multitable typed query — numeric currency over real /view (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: USER, roles: ['member'], perms: ['multitable:read'] }; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_ID, 'TQP Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_ID, BASE_ID, 'TQP Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_CUR, SHEET_ID, 'Amount', 'currency', JSON.stringify({ code: 'CNY', decimals: 2 }), 1])
    for (let i = 0; i < VALUES.length; i++) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
        [`rec_${TS}_${i}`, SHEET_ID, JSON.stringify({ [FLD_CUR]: VALUES[i] })])
    }
    // sort view: currency ascending
    await q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, filter_info, sort_info, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)',
      [V_SORT, SHEET_ID, V_SORT, 'grid', '[]', JSON.stringify({ conjunction: 'and', conditions: [] }),
        JSON.stringify({ rules: [{ fieldId: FLD_CUR, desc: false }] }), JSON.stringify({})])
    // filter view: currency > 1.5 (+ a sum aggregation so view-aggregate has config)
    await q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, filter_info, sort_info, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)',
      [V_FILTER, SHEET_ID, V_FILTER, 'grid', '[]',
        JSON.stringify({ conjunction: 'and', conditions: [{ fieldId: FLD_CUR, operator: 'greater', value: 1.5 }] }),
        JSON.stringify({ rules: [] }), JSON.stringify({ aggregations: { [FLD_CUR]: 'sum' } })])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('/view sorts currency by NUMERIC value (not lexicographic): incl. decimals + negative', async () => {
    const res = await request(app).get(`/api/multitable/view?sheetId=${SHEET_ID}&viewId=${V_SORT}&limit=10&offset=0`)
    expect(res.status).toBe(200)
    const order = (res.body.data.rows as Array<{ data: Record<string, unknown> }>).map((r) => r.data[FLD_CUR])
    expect(order).toEqual(ASC)
  })

  test('/view numeric sort holds ACROSS a page boundary (full-set sort, then paginate — not within-page only)', async () => {
    // ASC = [-5, 1.25, 1.5, 2, 10]. Page size 3 must split it 3 + 2 in numeric order.
    const p1 = await request(app).get(`/api/multitable/view?sheetId=${SHEET_ID}&viewId=${V_SORT}&limit=3&offset=0`)
    const p2 = await request(app).get(`/api/multitable/view?sheetId=${SHEET_ID}&viewId=${V_SORT}&limit=3&offset=3`)
    expect((p1.body.data.rows as Array<{ data: Record<string, unknown> }>).map((r) => r.data[FLD_CUR])).toEqual([-5, 1.25, 1.5])
    expect((p2.body.data.rows as Array<{ data: Record<string, unknown> }>).map((r) => r.data[FLD_CUR])).toEqual([2, 10])
  })

  test('/view applies a currency `greater` range filter (was a silent no-op via the string branch)', async () => {
    const res = await request(app).get(`/api/multitable/view?sheetId=${SHEET_ID}&viewId=${V_FILTER}&limit=10&offset=0`)
    expect(res.status).toBe(200)
    const vals = (res.body.data.rows as Array<{ data: Record<string, unknown> }>).map((r) => r.data[FLD_CUR]).sort((a: any, b: any) => a - b)
    expect(vals).toEqual([2, 10]) // > 1.5 → only 2 and 10
    expect(res.body.data.page.total).toBe(2)
  })

  test('PARITY: /view-aggregate agrees with /view on the currency-filtered set', async () => {
    const viewRes = await request(app).get(`/api/multitable/view?sheetId=${SHEET_ID}&viewId=${V_FILTER}&limit=1&offset=0`)
    const aggRes = await request(app).get(`/api/multitable/sheets/${SHEET_ID}/view-aggregate?viewId=${V_FILTER}`)
    expect(aggRes.status).toBe(200)
    expect(viewRes.body.data.page.total).toBe(2)
    expect(aggRes.body.data.total).toBe(viewRes.body.data.page.total)
  })
})
