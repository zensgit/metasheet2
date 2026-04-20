/**
 * Dashboard router HTTP-level wiring test.
 *
 * Why this test exists: the 2026-04-20 monthly delivery audit
 * (docs/operations/monthly-delivery-audit-20260420.md) found that
 * dashboardRouter() was defined but never mounted, so /api/multitable/sheets
 * URLs 404'd silently. The existing chart-dashboard.test.ts covered the
 * service layer directly and passed, but never exercised a single HTTP
 * route. This test plugs that gap and would regress if anyone removes the
 * router mount in index.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { dashboardRouter, getDashboardService } from '../../src/routes/dashboard'

// Mount on a fresh app in the same way index.ts does.
function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/multitable', dashboardRouter())
  return app
}

describe('dashboardRouter HTTP mounting', () => {
  const service = getDashboardService()

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('GET /api/multitable/sheets/:sheetId/charts returns shape { charts: [...] }', async () => {
    vi.spyOn(service, 'listCharts').mockResolvedValue([
      { id: 'chart-1', sheetId: 'sheet-a', name: 'Test', type: 'number' } as any,
    ])

    const res = await request(buildApp())
      .get('/api/multitable/sheets/sheet-a/charts')
      .expect(200)

    // Frontend (apps/web/src/multitable/api/client.ts) expects { charts: [...] }
    expect(res.body).toHaveProperty('charts')
    expect(Array.isArray(res.body.charts)).toBe(true)
    expect(res.body.charts).toHaveLength(1)
    // The old shape { items } MUST NOT appear — frontend would ignore it.
    expect(res.body.items).toBeUndefined()
  })

  it('GET /api/multitable/sheets/:sheetId/dashboards returns shape { dashboards: [...] }', async () => {
    vi.spyOn(service, 'listDashboards').mockResolvedValue([
      { id: 'dash-1', sheetId: 'sheet-a', name: 'Main', panels: [] } as any,
    ])

    const res = await request(buildApp())
      .get('/api/multitable/sheets/sheet-a/dashboards')
      .expect(200)

    expect(res.body).toHaveProperty('dashboards')
    expect(Array.isArray(res.body.dashboards)).toBe(true)
    expect(res.body.dashboards).toHaveLength(1)
    expect(res.body.items).toBeUndefined()
  })

  it('POST /api/multitable/sheets/:sheetId/charts creates and returns a chart', async () => {
    vi.spyOn(service, 'createChart').mockResolvedValue({
      id: 'new-chart',
      sheetId: 'sheet-a',
      name: 'New',
      type: 'bar',
    } as any)

    const res = await request(buildApp())
      .post('/api/multitable/sheets/sheet-a/charts')
      .set('X-User-Id', 'user-1')
      .send({ name: 'New', type: 'bar' })
      .expect(201)

    expect(res.body).toMatchObject({ id: 'new-chart', name: 'New', type: 'bar' })
  })

  it('GET /api/multitable/sheets/:sheetId/charts/:id/data returns the computed data', async () => {
    vi.spyOn(service, 'getChart').mockResolvedValue({
      id: 'chart-1', sheetId: 'sheet-a', name: 'c', type: 'bar',
    } as any)
    vi.spyOn(service, 'getChartData').mockResolvedValue({
      dataPoints: [{ label: 'A', value: 1 }],
    } as any)

    const res = await request(buildApp())
      .get('/api/multitable/sheets/sheet-a/charts/chart-1/data')
      .expect(200)

    expect(res.body).toHaveProperty('dataPoints')
  })

  it('GET on a chart that belongs to a different sheet returns 404', async () => {
    vi.spyOn(service, 'getChart').mockResolvedValue({
      id: 'chart-x', sheetId: 'sheet-OTHER', name: 'c', type: 'bar',
    } as any)

    await request(buildApp())
      .get('/api/multitable/sheets/sheet-a/charts/chart-x')
      .expect(404)
  })

  it('DELETE /api/multitable/sheets/:sheetId/dashboards/:id returns 204', async () => {
    vi.spyOn(service, 'getDashboard').mockResolvedValue({
      id: 'dash-1', sheetId: 'sheet-a', name: 'M', panels: [],
    } as any)
    vi.spyOn(service, 'deleteDashboard').mockResolvedValue(undefined as any)

    await request(buildApp())
      .delete('/api/multitable/sheets/sheet-a/dashboards/dash-1')
      .expect(204)
  })

  // Catches the legacy "/:sheetId/charts" path shape that was broken before
  // the 2026-04-20 fix — this URL no longer has a handler.
  it('legacy path without /sheets/ returns 404 (not accidentally matched)', async () => {
    await request(buildApp())
      .get('/api/multitable/sheet-a/charts')
      .expect(404)
  })
})
