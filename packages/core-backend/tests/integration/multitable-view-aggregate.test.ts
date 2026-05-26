/**
 * D3d-style real-DB integration test for the aggregation footer endpoint
 * GET /api/multitable/sheets/:sheetId/view-aggregate (benchmark v2 #4-3b-1).
 *
 * Backend-first: confirms security (hidden field omitted), correctness (full filtered set, not a page),
 * parity with /view's filtered total, fn semantics, and the max-rows hard-fail — BEFORE any frontend.
 * Runs only with DATABASE_URL (describeIfDatabase) via the dedicated plugin-tests.yml step.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const USER = `u_agg_${TS}`
const BASE_ID = `base_agg_${TS}`
const SHEET_ID = `sheet_agg_${TS}`
const FLD_QTY = `fld_qty_${TS}`
const FLD_CAT = `fld_cat_${TS}`
const FLD_SECRET = `fld_secret_${TS}`
const FLD_NOTE = `fld_note_${TS}`
const V_MAIN = `v_main_${TS}`
const V_FILTER = `v_filter_${TS}`
const V_SECRET = `v_secret_${TS}`
const V_BADFN = `v_badfn_${TS}`
const N = 60 // > default page size (50) → proves full-set, not page

let app: Express
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

async function aggregate(viewId: string) {
  const res = await request(app).get(`/api/multitable/sheets/${SHEET_ID}/view-aggregate?viewId=${viewId}`)
  return res
}

describeIfDatabase('multitable view-aggregate (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: USER, roles: ['member'], perms: ['multitable:read'] }; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_ID, 'Agg Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_ID, BASE_ID, 'Agg Sheet'])
    for (const [fid, name, type, order] of [
      [FLD_QTY, 'Qty', 'number', 1], [FLD_CAT, 'Cat', 'string', 2],
      [FLD_SECRET, 'Secret', 'number', 3], [FLD_NOTE, 'Note', 'string', 4],
    ] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fid, SHEET_ID, name, type, '{}', order])
    }
    for (let i = 1; i <= N; i++) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
        `rec_${TS}_${i}`, SHEET_ID,
        JSON.stringify({ [FLD_QTY]: i, [FLD_CAT]: i % 2 === 1 ? 'A' : 'B', [FLD_SECRET]: i, [FLD_NOTE]: i % 3 === 0 ? '' : 'x' }),
      ])
    }
    const view = (id: string, aggregations: Record<string, string>, filter: unknown) =>
      q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, filter_info, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)',
        [id, SHEET_ID, id, 'grid', '[]', JSON.stringify(filter ?? { conjunction: 'and', conditions: [] }), JSON.stringify({ aggregations })])
    await view(V_MAIN, { [FLD_QTY]: 'sum', [FLD_NOTE]: 'countNonEmpty', [FLD_CAT]: 'count' }, null)
    await view(V_FILTER, { [FLD_QTY]: 'sum' }, { conjunction: 'and', conditions: [{ fieldId: FLD_CAT, operator: 'is', value: 'A' }] })
    await view(V_SECRET, { [FLD_SECRET]: 'sum', [FLD_QTY]: 'sum' }, null)
    await view(V_BADFN, { [FLD_CAT]: 'sum' }, null) // sum on a string field → not applicable
    // hide fld_secret from this user (subject-scoped) — its aggregate must be OMITTED
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER, false, false])
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    delete process.env.MULTITABLE_AGGREGATE_MAX_ROWS
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('aggregates the FULL filtered set (not a page): sum over 60 rows', async () => {
    const res = await aggregate(V_MAIN)
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(N)
    expect(res.body.data.aggregates[FLD_QTY]).toEqual({ fn: 'sum', value: 1830 }) // 1+..+60
    expect(res.body.data.aggregates[FLD_NOTE]).toEqual({ fn: 'countNonEmpty', value: 40 }) // 60 - 20 empty (i%3==0)
    expect(res.body.data.aggregates[FLD_CAT]).toEqual({ fn: 'count', value: 60 })
  })

  test('PARITY: /view-aggregate total === /view page.total (no search-predicate drift)', async () => {
    const viewRes = await request(app).get(`/api/multitable/view?sheetId=${SHEET_ID}&viewId=${V_MAIN}`)
    const aggRes = await aggregate(V_MAIN)
    expect(aggRes.body.data.total).toBe(viewRes.body.data.page.total)
  })

  test('respects PERSISTED view filter (cat=A) over the full set', async () => {
    const res = await aggregate(V_FILTER)
    expect(res.body.data.total).toBe(30) // odd i → cat A
    expect(res.body.data.aggregates[FLD_QTY]).toEqual({ fn: 'sum', value: 900 }) // 1+3+...+59 = 30^2
  })

  test('SECURITY: hidden field (field_permissions.visible=false) aggregate is OMITTED', async () => {
    const res = await aggregate(V_SECRET)
    expect(res.body.data.aggregates[FLD_QTY]).toBeDefined() // visible field present
    expect(res.body.data.aggregates[FLD_SECRET]).toBeUndefined() // hidden → omitted, NOT null/0
  })

  test('fn not applicable to field type (sum on string) is omitted', async () => {
    const res = await aggregate(V_BADFN)
    expect(res.body.data.aggregates[FLD_CAT]).toBeUndefined()
  })

  test('max-rows guard HARD-FAILS with 413 + total (never truncates)', async () => {
    process.env.MULTITABLE_AGGREGATE_MAX_ROWS = '10'
    const res = await aggregate(V_MAIN)
    delete process.env.MULTITABLE_AGGREGATE_MAX_ROWS
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('AGGREGATE_TOO_LARGE')
    expect(res.body.error.total).toBe(N)
  })
})
