/**
 * Real-DB integration test for Dashboard BI v2-b2 — inline chart preview data.
 * Design-lock: docs/development/multitable-dashboard-bi-v2b2-preview-design-20260604.md (#2283).
 *
 * The preview endpoint must compute unsaved chart configs through the same engine and
 * field gate as persisted chart data. It deliberately avoids /dashboard/query because
 * that route has a narrower widget model and a different response shape.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { dashboardRouter, getDashboardService } from '../../src/routes/dashboard'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_biv2b2_${TS}`
const SHEET_ID = `sheet_biv2b2_${TS}`
const FLD_STATUS = `fld_biv2b2_status_${TS}`
const FLD_AMOUNT = `fld_biv2b2_amount_${TS}`
const FLD_DATE = `fld_biv2b2_date_${TS}`
const FLD_SECRET = `fld_biv2b2_secret_${TS}`
const CHART_PARITY_ID = `chart_biv2b2_parity_${TS}`
const CHART_STACKED_ID = `chart_biv2b2_stacked_${TS}` // v2-d: persisted stacked chart for preview parity
const USER_ID = `u_biv2b2_reader_${TS}`
const USER_DENIED = `u_biv2b2_denied_${TS}`

let app: Express
let testUserId = USER_ID
let testPerms: string[] = ['multitable:read']

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const asJson = (value: unknown) => JSON.stringify(value)

const rows = [
  { data: { [FLD_STATUS]: 'open', [FLD_AMOUNT]: 10, [FLD_DATE]: '2026-01-15', [FLD_SECRET]: 'secret-canary' } },
  { data: { [FLD_STATUS]: 'open', [FLD_AMOUNT]: 20, [FLD_DATE]: '2026-01-20', [FLD_SECRET]: 'secret-canary' } },
  { data: { [FLD_STATUS]: 'closed', [FLD_AMOUNT]: 30, [FLD_DATE]: '2026-02-10', [FLD_SECRET]: 'other' } },
]

function installUser(req: express.Request, _res: express.Response, next: express.NextFunction) {
  ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined
  next()
}

function preview(payload: Record<string, unknown>) {
  return request(app)
    .post(`/api/multitable/sheets/${SHEET_ID}/charts/preview-data`)
    .send(payload)
}

function normalizeChartData(data: Record<string, unknown>) {
  const { chartId: _chartId, ...rest } = data
  return rest
}

describeIfDatabase('Dashboard BI v2-b2 preview-data endpoint (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use(installUser)
    app.use('/api/multitable', dashboardRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'BI v2-b2 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'BI v2-b2 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_STATUS, SHEET_ID, 'Status', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_AMOUNT, SHEET_ID, 'Amount', 'number', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_DATE, SHEET_ID, 'Date', 'date', '{}', 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRET, SHEET_ID, 'Secret', 'string', '{}', 4])
    await q(
      'INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [SHEET_ID, FLD_SECRET, 'user', USER_DENIED, false, false],
    )
    await q(
      `INSERT INTO multitable_charts (id, name, type, sheet_id, data_source, display, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
      [
        CHART_PARITY_ID,
        'Persisted parity chart',
        'bar',
        SHEET_ID,
        asJson({ groupByFieldId: FLD_STATUS, aggregation: { function: 'sum', fieldId: FLD_AMOUNT } }),
        asJson({ title: 'Persisted parity chart' }),
        USER_ID,
      ],
    )
    await q(
      `INSERT INTO multitable_charts (id, name, type, sheet_id, data_source, display, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
      [
        CHART_STACKED_ID,
        'Persisted stacked chart',
        'bar',
        SHEET_ID,
        asJson({ groupByFieldId: FLD_STATUS, seriesByFieldId: FLD_SECRET, aggregation: { function: 'sum', fieldId: FLD_AMOUNT } }),
        asJson({ title: 'Persisted stacked chart' }),
        USER_ID,
      ],
    )
  })

  beforeEach(() => {
    testUserId = USER_ID
    testPerms = ['multitable:read']
    getDashboardService().setRecordProvider(async (sheetId: string) => (sheetId === SHEET_ID ? rows : []))
  })

  afterAll(async () => {
    getDashboardService().setRecordProvider(async () => [])
    await q('DELETE FROM multitable_charts WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('P1: preview matches persisted chart data for equivalent config', async () => {
    const persisted = await request(app).get(`/api/multitable/sheets/${SHEET_ID}/charts/${CHART_PARITY_ID}/data`)
    expect(persisted.status).toBe(200)

    const res = await preview({
      name: 'Unsaved parity chart',
      type: 'bar',
      dataSource: { groupByFieldId: FLD_STATUS, aggregation: { function: 'sum', fieldId: FLD_AMOUNT } },
      display: { title: 'Unsaved parity chart' },
    })
    expect(res.status).toBe(200)
    expect(normalizeChartData(res.body)).toEqual(normalizeChartData(persisted.body))
  })

  test('P2: preview supports cases outside /dashboard/query (date grouping, number max, table max)', async () => {
    const date = await preview({
      name: 'By month',
      type: 'line',
      dataSource: { dateFieldId: FLD_DATE, dateGrouping: 'month', aggregation: { function: 'count' } },
    })
    expect(date.status).toBe(200)
    expect(date.body.chartType).toBe('line')
    expect(date.body.dataPoints.map((point: { label: string }) => point.label)).toContain('2026-01')

    const number = await preview({
      name: 'Max amount',
      type: 'number',
      dataSource: { groupByFieldId: FLD_STATUS, aggregation: { function: 'max', fieldId: FLD_AMOUNT } },
    })
    expect(number.status).toBe(200)
    expect(number.body.chartType).toBe('number')
    expect(number.body.total).toBe(30)

    const table = await preview({
      name: 'Table max',
      type: 'table',
      dataSource: { groupByFieldId: FLD_STATUS, aggregation: { function: 'max', fieldId: FLD_AMOUNT } },
    })
    expect(table.status).toBe(200)
    expect(table.body.chartType).toBe('table')
    expect(table.body.dataPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'open', value: 20 }),
      expect.objectContaining({ label: 'closed', value: 30 }),
    ]))
  })

  test('P3: denied referenced field returns restricted state without computing records', async () => {
    testUserId = USER_DENIED
    const provider = vi.fn(async () => rows)
    getDashboardService().setRecordProvider(provider)

    const res = await preview({
      name: 'Denied secret',
      type: 'bar',
      dataSource: { groupByFieldId: FLD_SECRET, aggregation: { function: 'count' } },
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      chartType: 'bar',
      dataPoints: [],
      total: 0,
      metadata: { restricted: true, recordCount: 0 },
    })
    expect(JSON.stringify(res.body)).not.toContain('secret-canary')
    expect(provider).not.toHaveBeenCalled()
  })

  test('P4: invalid preview config returns 400 instead of computing a misleading chart', async () => {
    const res = await preview({
      name: 'Missing value',
      type: 'bar',
      dataSource: { groupByFieldId: FLD_STATUS, aggregation: { function: 'sum' } },
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('value field')

    const date = await preview({
      name: 'Invalid date grouping',
      type: 'line',
      dataSource: { dateFieldId: FLD_DATE, dateGrouping: 'decade', aggregation: { function: 'count' } },
    })
    expect(date.status).toBe(400)
    expect(JSON.stringify(date.body)).toContain('date grouping')
  })

  test('P5 (v2-d): stacked preview emits dense aligned series and matches persisted stacked-chart data', async () => {
    const persisted = await request(app).get(`/api/multitable/sheets/${SHEET_ID}/charts/${CHART_STACKED_ID}/data`)
    expect(persisted.status).toBe(200)
    expect(persisted.body.series).toBeDefined()

    const res = await preview({
      name: 'Unsaved stacked',
      type: 'bar',
      dataSource: { groupByFieldId: FLD_STATUS, seriesByFieldId: FLD_SECRET, aggregation: { function: 'sum', fieldId: FLD_AMOUNT } },
      display: { title: 'Persisted stacked chart' },
    })
    expect(res.status).toBe(200)
    // preview === saved (same engine + gate)
    expect(normalizeChartData(res.body)).toEqual(normalizeChartData(persisted.body))
    // dense + aligned + additive consistency (Σ segments === single-series bar)
    const body = res.body
    for (const s of body.series) expect(s.data).toHaveLength(body.dataPoints.length)
    body.dataPoints.forEach((dp: { value: number }, j: number) => {
      const col = body.series.reduce((acc: number, s: { data: number[] }) => acc + s.data[j], 0)
      expect(col).toBe(dp.value)
    })
  })

  test('P6 (v2-d): non-additive or non-bar series config is rejected with 400 (server-side, not UI-only)', async () => {
    const avg = await preview({
      name: 'avg stacked',
      type: 'bar',
      dataSource: { groupByFieldId: FLD_STATUS, seriesByFieldId: FLD_SECRET, aggregation: { function: 'avg', fieldId: FLD_AMOUNT } },
    })
    expect(avg.status).toBe(400)
    expect(JSON.stringify(avg.body)).toContain('sum or count')

    const line = await preview({
      name: 'line stacked',
      type: 'line',
      dataSource: { groupByFieldId: FLD_STATUS, seriesByFieldId: FLD_SECRET, aggregation: { function: 'count' } },
    })
    expect(line.status).toBe(400)
    expect(JSON.stringify(line.body)).toContain('bar charts')
  })

  test('P7 (v2-d-b1): grouped barMode accepts a non-additive aggregation and emits series', async () => {
    const res = await preview({
      name: 'grouped avg',
      type: 'bar',
      dataSource: { groupByFieldId: FLD_STATUS, seriesByFieldId: FLD_SECRET, aggregation: { function: 'avg', fieldId: FLD_AMOUNT } },
      display: { barMode: 'grouped' },
    })
    expect(res.status).toBe(200) // same config 400s when stacked (P6) — grouped relaxes additive-only
    expect(Array.isArray(res.body.series)).toBe(true)
    expect(res.body.series.length).toBeGreaterThan(0)
  })
})
