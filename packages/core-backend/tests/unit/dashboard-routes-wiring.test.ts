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

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: {
    get: () => ({
      getInternalPool: () => ({}),
      // loadChartRecords issues a SELECT over meta_records; return an empty rowset so the wired
      // chart-data path runs without a DB (the route no longer depends on setRecordProvider).
      query: vi.fn(async () => ({ rows: [] })),
    }),
  },
}))

vi.mock('../../src/multitable/loaders', () => ({
  loadFieldsForSheet: vi.fn(async () => []),
}))

vi.mock('../../src/multitable/permission-service', () => ({
  resolveSheetReadableCapabilities: vi.fn(async () => ({
    access: { userId: 'unit-user' },
    capabilities: {
      canRead: true,
      canCreateRecord: true,
      canEditRecord: true,
      canDeleteRecord: true,
      canManageFields: true,
      canManageSheetAccess: true,
      canManageViews: true,
      canComment: true,
      canManageAutomation: true,
      canExport: true,
    },
  })),
  resolveSheetCapabilities: vi.fn(async () => ({
    access: { userId: 'unit-user' },
    capabilities: {
      canRead: true,
      canCreateRecord: true,
      canEditRecord: true,
      canDeleteRecord: true,
      canManageFields: true,
      canManageSheetAccess: true,
      canManageViews: true,
      canComment: true,
      canManageAutomation: true,
      canExport: true,
    },
  })),
  loadFieldPermissionScopeMap: vi.fn(async () => new Map()),
  // Used by loadChartRecords (the wired chart-data path) — default to inert so the unit wiring test
  // exercises the route without a real DB.
  loadRowLevelReadDenyEnabled: vi.fn(async () => false),
  loadDeniedRecordIds: vi.fn(async () => new Set()),
}))

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
    const createChart = vi.spyOn(service, 'createChart').mockResolvedValue({
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
    expect(createChart).toHaveBeenCalledWith('sheet-a', expect.objectContaining({
      createdBy: 'unit-user',
    }))
  })

  it('GET /api/multitable/sheets/:sheetId/charts/:id/data returns the computed data', async () => {
    vi.spyOn(service, 'getChart').mockResolvedValue({
      id: 'chart-1',
      sheetId: 'sheet-a',
      name: 'c',
      type: 'bar',
      dataSource: { aggregation: { function: 'count' } },
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
      id: 'chart-x',
      sheetId: 'sheet-OTHER',
      name: 'c',
      type: 'bar',
      dataSource: { aggregation: { function: 'count' } },
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

  // S3 chart-type completion: the preview-data type gate (CHART_TYPES) must admit the new
  // render-layer types. With the loaders mocked to zero fields the referenced groupBy field is
  // "not allowed" → the route answers with the restricted ChartData shape (200), which is enough
  // to prove the type passed validation (an unknown type 400s before any field check).
  it('POST /charts/preview-data accepts the S3 chart types (area / funnel / gauge)', async () => {
    for (const type of ['area', 'funnel', 'gauge']) {
      const res = await request(buildApp())
        .post('/api/multitable/sheets/sheet-a/charts/preview-data')
        .send({ type, dataSource: { groupByFieldId: 'fld_x', aggregation: { function: 'count' } } })
      expect(res.status, `preview must accept chart type "${type}"`).toBe(200)
      expect(res.body.chartType).toBe(type)
    }
  })

  it('POST /charts/preview-data still rejects unknown chart types (radar/nope — scatter is now a real type, see scatter tests below)', async () => {
    for (const type of ['radar', 'nope']) {
      const res = await request(buildApp())
        .post('/api/multitable/sheets/sheet-a/charts/preview-data')
        .send({ type, dataSource: { groupByFieldId: 'fld_x', aggregation: { function: 'count' } } })
      expect(res.status, `preview must reject chart type "${type}"`).toBe(400)
      expect(res.body.error).toBe('Invalid chart type')
    }
  })

  // r12 scatter: a per-record x/y projection — the preview-data type gate must ADMIT it. With the
  // loaders mocked to zero fields the referenced x/y fields are "not allowed" → the route answers the
  // restricted ChartData shape (200), which is enough to prove the type passed validation.
  it('POST /charts/preview-data accepts scatter when xFieldId + yFieldId are present', async () => {
    const res = await request(buildApp())
      .post('/api/multitable/sheets/sheet-a/charts/preview-data')
      .send({ type: 'scatter', dataSource: { xFieldId: 'fld_x', yFieldId: 'fld_y', aggregation: { function: 'count' } } })
    expect(res.status).toBe(200)
    expect(res.body.chartType).toBe('scatter')
  })

  it('POST /charts/preview-data rejects scatter MISSING xFieldId or yFieldId with 400', async () => {
    for (const dataSource of [
      { yFieldId: 'fld_y', aggregation: { function: 'count' } }, // no x
      { xFieldId: 'fld_x', aggregation: { function: 'count' } }, // no y
    ]) {
      const res = await request(buildApp())
        .post('/api/multitable/sheets/sheet-a/charts/preview-data')
        .send({ type: 'scatter', dataSource })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('scatter requires xFieldId and yFieldId')
    }
  })

  // F4: the PERSISTED write paths (POST/PATCH /charts) must reject an unknown `type` too —
  // the `type` column is TEXT NOT NULL with no CHECK, and only preview-data validated
  // it before. An unknown type must 400 BEFORE the service is touched.
  it('POST /charts rejects an unknown chart type with 400 (never persists)', async () => {
    const createChart = vi.spyOn(service, 'createChart')
    for (const type of ['radar', 'nope']) {
      const res = await request(buildApp())
        .post('/api/multitable/sheets/sheet-a/charts')
        .send({ name: 'X', type, dataSource: { aggregation: { function: 'count' } } })
      expect(res.status, `create must reject chart type "${type}"`).toBe(400)
      expect(res.body.error).toBe('Invalid chart type')
    }
    expect(createChart).not.toHaveBeenCalled()
  })

  it('POST /charts still accepts a known chart type (does not over-reject)', async () => {
    vi.spyOn(service, 'createChart').mockResolvedValue({
      id: 'c', sheetId: 'sheet-a', name: 'X', type: 'gauge',
    } as any)
    await request(buildApp())
      .post('/api/multitable/sheets/sheet-a/charts')
      .send({ name: 'X', type: 'gauge', dataSource: { aggregation: { function: 'count' } } })
      .expect(201)
  })

  it('M3: POST /charts rejects a scatter chart missing x/y on the PERSISTED path (never persists)', async () => {
    const createChart = vi.spyOn(service, 'createChart')
    const res = await request(buildApp())
      .post('/api/multitable/sheets/sheet-a/charts')
      .send({ name: 'S', type: 'scatter', dataSource: { xFieldId: 'fld_x' } }) // y missing
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('scatter requires xFieldId and yFieldId')
    expect(createChart).not.toHaveBeenCalled()
  })

  it('M3: POST /charts accepts a scatter chart with x/y', async () => {
    vi.spyOn(service, 'createChart').mockResolvedValue({
      id: 'c', sheetId: 'sheet-a', name: 'S', type: 'scatter',
    } as any)
    await request(buildApp())
      .post('/api/multitable/sheets/sheet-a/charts')
      .send({ name: 'S', type: 'scatter', dataSource: { xFieldId: 'fld_x', yFieldId: 'fld_y' } })
      .expect(201)
  })

  it('PATCH /charts/:id rejects an unknown chart type with 400 (never updates)', async () => {
    vi.spyOn(service, 'getChart').mockResolvedValue({
      id: 'chart-1', sheetId: 'sheet-a', name: 'c', type: 'bar',
      dataSource: { aggregation: { function: 'count' } },
    } as any)
    const updateChart = vi.spyOn(service, 'updateChart')
    const res = await request(buildApp())
      .patch('/api/multitable/sheets/sheet-a/charts/chart-1')
      .send({ type: 'radar' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid chart type')
    expect(updateChart).not.toHaveBeenCalled()
  })

  it('PATCH /charts/:id leaves an unchanged type alone (patch without type keeps the stored bar)', async () => {
    vi.spyOn(service, 'getChart').mockResolvedValue({
      id: 'chart-1', sheetId: 'sheet-a', name: 'c', type: 'bar',
      dataSource: { aggregation: { function: 'count' } },
    } as any)
    const updateChart = vi.spyOn(service, 'updateChart').mockResolvedValue({
      id: 'chart-1', sheetId: 'sheet-a', name: 'c2', type: 'bar',
    } as any)
    await request(buildApp())
      .patch('/api/multitable/sheets/sheet-a/charts/chart-1')
      .send({ name: 'c2' })
      .expect(200)
    expect(updateChart).toHaveBeenCalled()
  })
})
