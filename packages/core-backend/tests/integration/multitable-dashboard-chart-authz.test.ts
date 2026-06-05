/**
 * Real-DB integration test for F0b — dashboard/chart route sheet authz + chart-data field mask.
 * Design-lock: docs/development/multitable-dashboard-chart-authz-design-20260530.md (#2125).
 *
 * F0b closes the dashboard/chart counterpart of F0a: dashboard/chart config routes must enforce
 * sheet canRead / canManageViews, and chart data must withhold output when the chart references a
 * field the requester cannot read. The value-leak side is forward-defense: production chart data
 * still has no real record provider, but the test injects one so future provider wiring cannot land
 * without the mask.
 *
 * Seed non-negotiable: FLD_SECRET.property = {} (property.hidden UNSET) so the deny is SOLELY
 * layer-3 (field_permissions.visible=false). If it were also static-hidden, layer-2 would prove
 * the wrong thing.
 *
 * Runs only with DATABASE_URL (describeIfDatabase + a sentinel test so it fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { dashboardRouter, getDashboardService } from '../../src/routes/dashboard'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_f0b_${TS}`
const SHEET_ID = `sheet_f0b_${TS}`
const FLD_VISIBLE = `fld_f0b_visible_${TS}`
const FLD_SECRET = `fld_f0b_secret_${TS}`
const CHART_ID = `chart_f0b_visible_${TS}`
const CHART_SECRET_ID = `chart_f0b_secret_${TS}`
const CHART_SERIES_SECRET_ID = `chart_f0b_series_secret_${TS}` // v2-d: seriesByFieldId points at the denied field
const DASHBOARD_ID = `dash_f0b_${TS}`
const USER_ID = `u_f0b_reader_${TS}`
const USER_ID_DENIED = `u_f0b_denied_${TS}`
const MANAGER_ID = `u_f0b_manager_${TS}`
const SECRET_CANARY = 'do-not-leak-dashboard-canary'

let app: Express
let testUserId = USER_ID
let testPerms: string[] = ['multitable:read']

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const asJson = (value: unknown) => JSON.stringify(value)

function installUser(req: express.Request, _res: express.Response, next: express.NextFunction) {
  ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined
  next()
}

function chartPayload(name = 'Created Chart') {
  return {
    name,
    type: 'bar',
    dataSource: {
      groupByFieldId: FLD_VISIBLE,
      aggregation: { function: 'count' },
    },
    display: {},
  }
}

async function insertChart(id: string, dataSource: Record<string, unknown> = {
  groupByFieldId: FLD_VISIBLE,
  aggregation: { function: 'count' },
}) {
  await q(
    `INSERT INTO multitable_charts (id, name, type, sheet_id, data_source, display, created_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
     ON CONFLICT (id) DO NOTHING`,
    [id, `Chart ${id}`, 'bar', SHEET_ID, asJson(dataSource), '{}', MANAGER_ID],
  )
}

async function insertDashboard(id: string) {
  await q(
    `INSERT INTO multitable_dashboards (id, name, sheet_id, panels, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT (id) DO NOTHING`,
    [id, `Dashboard ${id}`, SHEET_ID, asJson([{ id: `panel_${id}`, chartId: CHART_ID, x: 0, y: 0, w: 4, h: 4 }]), MANAGER_ID],
  )
}

const chartList = () => request(app).get(`/api/multitable/sheets/${SHEET_ID}/charts`)
const chartGet = (id = CHART_ID) => request(app).get(`/api/multitable/sheets/${SHEET_ID}/charts/${id}`)
const chartData = (id = CHART_ID) => request(app).get(`/api/multitable/sheets/${SHEET_ID}/charts/${id}/data`)
const dashboardList = () => request(app).get(`/api/multitable/sheets/${SHEET_ID}/dashboards`)
const dashboardGet = (id = DASHBOARD_ID) => request(app).get(`/api/multitable/sheets/${SHEET_ID}/dashboards/${id}`)

describeIfDatabase('F0b dashboard/chart authz + chart-data mask (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use(installUser)
    app.use('/api/multitable', dashboardRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'F0b Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'F0b Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VISIBLE, SHEET_ID, 'Visible', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRET, SHEET_ID, 'Secret', 'string', '{}', 2])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER_ID_DENIED, false, false])

    await insertChart(CHART_ID)
    await insertChart(CHART_SECRET_ID, {
      groupByFieldId: FLD_SECRET,
      aggregation: { function: 'count' },
    })
    // v2-d: a stacked chart whose SERIES field is the denied one (primary groupBy is visible).
    await insertChart(CHART_SERIES_SECRET_ID, {
      groupByFieldId: FLD_VISIBLE,
      seriesByFieldId: FLD_SECRET,
      aggregation: { function: 'count' },
    })
    await insertDashboard(DASHBOARD_ID)
  })

  beforeEach(() => {
    testUserId = USER_ID
    testPerms = ['multitable:read']
    getDashboardService().setRecordProvider(async () => [])
  })

  afterAll(async () => {
    getDashboardService().setRecordProvider(async () => [])
    await q('DELETE FROM multitable_dashboards WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM multitable_charts WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('R1: non-reader cannot list chart configs', async () => {
    testPerms = []
    const res = await chartList()
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain(CHART_ID)
  })

  test('R2: non-reader cannot get an individual chart config', async () => {
    testPerms = []
    const res = await chartGet()
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain(CHART_ID)
  })

  test('R3: non-reader cannot get chart data', async () => {
    testPerms = []
    const res = await chartData()
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain('dataPoints')
  })

  test('R4: reader without canManageViews cannot create, update, or delete charts', async () => {
    const deleteId = `chart_f0b_delete_denied_${TS}`
    await insertChart(deleteId)

    const create = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/charts`)
      .send(chartPayload('Denied Create'))
    expect(create.status).toBe(403)

    const update = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/charts/${CHART_ID}`)
      .send({ name: 'Denied Update' })
    expect(update.status).toBe(403)

    const del = await request(app).delete(`/api/multitable/sheets/${SHEET_ID}/charts/${deleteId}`)
    expect(del.status).toBe(403)
  })

  test('R5: non-reader cannot read or manage dashboards', async () => {
    testPerms = []
    const deleteId = `dash_f0b_delete_denied_${TS}`
    await insertDashboard(deleteId)

    expect((await dashboardList()).status).toBe(403)
    expect((await dashboardGet()).status).toBe(403)
    expect((await request(app).post(`/api/multitable/sheets/${SHEET_ID}/dashboards`).send({ name: 'Denied' })).status).toBe(403)
    expect((await request(app).patch(`/api/multitable/sheets/${SHEET_ID}/dashboards/${DASHBOARD_ID}`).send({ name: 'Denied' })).status).toBe(403)
    expect((await request(app).delete(`/api/multitable/sheets/${SHEET_ID}/dashboards/${deleteId}`)).status).toBe(403)
  })

  test('R6: a sheet reader can list/get charts, get chart data, and list/get dashboards', async () => {
    const charts = await chartList()
    expect(charts.status).toBe(200)
    expect(charts.body.charts.some((chart: { id?: string }) => chart.id === CHART_ID)).toBe(true)

    expect((await chartGet()).status).toBe(200)

    const data = await chartData()
    expect(data.status).toBe(200)
    expect(Array.isArray(data.body.dataPoints)).toBe(true)
    expect(data.body.metadata?.restricted).toBeUndefined()

    const dashboards = await dashboardList()
    expect(dashboards.status).toBe(200)
    expect(dashboards.body.dashboards.some((dashboard: { id?: string }) => dashboard.id === DASHBOARD_ID)).toBe(true)
    expect((await dashboardGet()).status).toBe(200)
  })

  test('R7: a canManageViews user can create, update, and delete charts and dashboards', async () => {
    testUserId = MANAGER_ID
    testPerms = ['multitable:write']

    const createChart = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/charts`)
      .send(chartPayload('Manager Create'))
    expect(createChart.status).toBe(201)
    const createdChartId = createChart.body.id as string

    const updateChart = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/charts/${createdChartId}`)
      .send({ name: 'Manager Update' })
    expect(updateChart.status).toBe(200)
    expect(updateChart.body.name).toBe('Manager Update')

    expect((await request(app).delete(`/api/multitable/sheets/${SHEET_ID}/charts/${createdChartId}`)).status).toBe(204)

    const createDashboard = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/dashboards`)
      .send({ name: 'Manager Dashboard' })
    expect(createDashboard.status).toBe(201)
    const createdDashboardId = createDashboard.body.id as string

    const updateDashboard = await request(app)
      .patch(`/api/multitable/sheets/${SHEET_ID}/dashboards/${createdDashboardId}`)
      .send({ name: 'Manager Dashboard Updated' })
    expect(updateDashboard.status).toBe(200)
    expect(updateDashboard.body.name).toBe('Manager Dashboard Updated')

    expect((await request(app).delete(`/api/multitable/sheets/${SHEET_ID}/dashboards/${createdDashboardId}`)).status).toBe(204)
  })

  test('R8: chart data withholds a denied referenced field while proving the injected provider can leak it for an allowed user', async () => {
    getDashboardService().setRecordProvider(async (sheetId: string) => {
      if (sheetId !== SHEET_ID) return []
      return [
        { data: { [FLD_VISIBLE]: 'visible bucket', [FLD_SECRET]: SECRET_CANARY } },
      ]
    })

    testUserId = USER_ID
    testPerms = ['multitable:read']
    const allowed = await chartData(CHART_SECRET_ID)
    expect(allowed.status).toBe(200)
    expect(JSON.stringify(allowed.body)).toContain(SECRET_CANARY)

    testUserId = USER_ID_DENIED
    testPerms = ['multitable:read']
    const denied = await chartData(CHART_SECRET_ID)
    expect(denied.status).toBe(200)
    expect(denied.body).toMatchObject({
      chartId: CHART_SECRET_ID,
      chartType: 'bar',
      dataPoints: [],
      total: 0,
      metadata: {
        restricted: true,
        recordCount: 0,
      },
    })
    expect(JSON.stringify(denied.body)).not.toContain(SECRET_CANARY)
  })

  test('R9 (v2-d): a denied seriesByFieldId restricts chart data — the field values do not leak as series names', async () => {
    // groupBy = visible bucket, seriesBy = the SECRET field → series names would be the secret values.
    getDashboardService().setRecordProvider(async (sheetId: string) => {
      if (sheetId !== SHEET_ID) return []
      return [{ data: { [FLD_VISIBLE]: 'visible bucket', [FLD_SECRET]: SECRET_CANARY } }]
    })

    // Allowed reader: series IS computed → the secret value surfaces as a series name (proves the leak vector).
    testUserId = USER_ID
    testPerms = ['multitable:read']
    const allowed = await chartData(CHART_SERIES_SECRET_ID)
    expect(allowed.status).toBe(200)
    expect(allowed.body.series?.some((s: { name?: string }) => s.name === SECRET_CANARY)).toBe(true)
    expect(JSON.stringify(allowed.body)).toContain(SECRET_CANARY)

    // Denied reader: restricted, no series, no leak.
    testUserId = USER_ID_DENIED
    testPerms = ['multitable:read']
    const denied = await chartData(CHART_SERIES_SECRET_ID)
    expect(denied.status).toBe(200)
    expect(denied.body).toMatchObject({ chartId: CHART_SERIES_SECRET_ID, dataPoints: [], total: 0, metadata: { restricted: true } })
    expect(denied.body.series).toBeUndefined()
    expect(JSON.stringify(denied.body)).not.toContain(SECRET_CANARY)
  })
})
