/**
 * Charts & dashboards × sheet liveness. Both are keyed by `sheet_id`, and chart data is aggregated from
 * `meta_records` without joining `meta_sheets`, so a soft-deleted sheet stayed fully addressable here.
 * `requireSheetRead` / `requireSheetManageViews` now refuse a non-live sheet, in the order
 * 401 → 403 → 404, so an unauthorized caller cannot tell a live sheet from a deleted one.
 *
 * The route table is the twelve handlers the all-routes closed-world guard classifies as sheet-addressed
 * in routes/dashboard.ts (multitable-sheet-liveness-closure-all-routes.guard.test.ts).
 */
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const mocks = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [] as unknown[] })),
  resolveSheetReadableCapabilities: vi.fn(),
  resolveSheetCapabilities: vi.fn(),
  loadFieldsForSheet: vi.fn(async () => [] as unknown[]),
}))

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ getInternalPool: () => ({}), query: mocks.query }) },
}))

vi.mock('../../src/multitable/loaders', () => ({
  loadFieldsForSheet: (...args: unknown[]) => mocks.loadFieldsForSheet(...args),
}))

vi.mock('../../src/multitable/permission-service', () => ({
  resolveSheetReadableCapabilities: (...args: unknown[]) => mocks.resolveSheetReadableCapabilities(...args),
  resolveSheetCapabilities: (...args: unknown[]) => mocks.resolveSheetCapabilities(...args),
  loadFieldPermissionScopeMap: vi.fn(async () => new Map()),
  loadRowLevelReadDenyEnabled: vi.fn(async () => false),
  loadDeniedRecordIds: vi.fn(async () => new Set()),
}))

import { dashboardRouter, getDashboardService } from '../../src/routes/dashboard'
import { SHEET_DELETED_CODE, SHEET_DELETED_MESSAGE, SHEET_NOT_FOUND_MESSAGE } from '../../src/multitable/sheet-liveness'

const SHEET = 'sheet_liveness_dash'
const BASE = `/api/multitable/sheets/${SHEET}`
const SERVICE_METHODS = [
  'createChart', 'getChart', 'listCharts', 'updateChart', 'deleteChart',
  'createDashboard', 'getDashboard', 'listDashboards', 'updateDashboard', 'deleteDashboard',
  'getChartData', 'computeChartDataForConfig',
] as const

const barChart = {
  name: 'Preview',
  type: 'bar',
  dataSource: { aggregation: { function: 'count' }, groupByFieldId: 'fld_a' },
}

type Agent = ReturnType<typeof request>
type Gate = 'read' | 'manage'
const ROUTES: Array<{ name: string; gate: Gate; send: (agent: Agent) => request.Test }> = [
  { name: 'GET /charts', gate: 'read', send: (a) => a.get(`${BASE}/charts`) },
  { name: 'POST /charts', gate: 'manage', send: (a) => a.post(`${BASE}/charts`).send(barChart) },
  { name: 'POST /charts/preview-data', gate: 'read', send: (a) => a.post(`${BASE}/charts/preview-data`).send(barChart) },
  { name: 'GET /charts/:id', gate: 'read', send: (a) => a.get(`${BASE}/charts/chart-1`) },
  { name: 'PATCH /charts/:id', gate: 'manage', send: (a) => a.patch(`${BASE}/charts/chart-1`).send({ name: 'x' }) },
  { name: 'DELETE /charts/:id', gate: 'manage', send: (a) => a.delete(`${BASE}/charts/chart-1`) },
  { name: 'GET /charts/:id/data', gate: 'read', send: (a) => a.get(`${BASE}/charts/chart-1/data`) },
  { name: 'GET /dashboards', gate: 'read', send: (a) => a.get(`${BASE}/dashboards`) },
  { name: 'POST /dashboards', gate: 'manage', send: (a) => a.post(`${BASE}/dashboards`).send({ name: 'd' }) },
  { name: 'GET /dashboards/:id', gate: 'read', send: (a) => a.get(`${BASE}/dashboards/dash-1`) },
  { name: 'PATCH /dashboards/:id', gate: 'manage', send: (a) => a.patch(`${BASE}/dashboards/dash-1`).send({ name: 'x' }) },
  { name: 'DELETE /dashboards/:id', gate: 'manage', send: (a) => a.delete(`${BASE}/dashboards/dash-1`) },
]

function grant(opts: { userId?: string; canRead?: boolean; canManageViews?: boolean; sheetLiveness: 'live' | 'deleted' | 'absent' }) {
  const value = {
    access: { userId: opts.userId ?? 'unit-user', isAdminRole: false },
    capabilities: { canRead: opts.canRead ?? true, canManageViews: opts.canManageViews ?? true },
    sheetLiveness: opts.sheetLiveness,
  }
  mocks.resolveSheetReadableCapabilities.mockResolvedValue(value)
  mocks.resolveSheetCapabilities.mockResolvedValue(value)
}

const pinned = usePinnedServer()

describe('dashboard routes refuse a non-live sheet', () => {
  const service = getDashboardService()
  let spies: Array<ReturnType<typeof vi.spyOn>>

  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.query.mockClear()
    mocks.resolveSheetReadableCapabilities.mockReset()
    mocks.resolveSheetCapabilities.mockReset()
    spies = SERVICE_METHODS.map((method) => vi.spyOn(service, method as never).mockResolvedValue(undefined as never))
    const app = express()
    app.use(express.json())
    app.use('/api/multitable', dashboardRouter())
    pinned.setApp(app)
  })

  const untouched = () => {
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.loadFieldsForSheet).not.toHaveBeenCalled()
  }

  it('covers the twelve sheet-addressed dashboard routes', () => {
    expect(new Set(ROUTES.map((r) => r.name)).size).toBe(12)
  })

  for (const route of ROUTES) {
    describe(route.name, () => {
      it('soft-deleted sheet → 404 SHEET_DELETED; no service call, no record or field read', async () => {
        mocks.loadFieldsForSheet.mockClear()
        grant({ sheetLiveness: 'deleted' })
        const res = await route.send(request(pinned.url()))
        expect(res.status).toBe(404)
        expect(res.body).toEqual({ ok: false, error: { code: SHEET_DELETED_CODE, message: SHEET_DELETED_MESSAGE } })
        untouched()
        const resolver = route.gate === 'read' ? mocks.resolveSheetReadableCapabilities : mocks.resolveSheetCapabilities
        expect(resolver).toHaveBeenCalledWith(expect.anything(), expect.any(Function), SHEET)
      })

      it('absent sheet → 404 NOT_FOUND (values-free)', async () => {
        mocks.loadFieldsForSheet.mockClear()
        grant({ sheetLiveness: 'absent' })
        const res = await route.send(request(pinned.url()))
        expect(res.status).toBe(404)
        expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: SHEET_NOT_FOUND_MESSAGE } })
        untouched()
      })

      it('not permitted → the same 403 for a live and a deleted sheet; unauthenticated → 401 either way', async () => {
        mocks.loadFieldsForSheet.mockClear()
        const denied = route.gate === 'read' ? { canRead: false } : { canManageViews: false }
        grant({ ...denied, sheetLiveness: 'live' })
        const live = await route.send(request(pinned.url()))
        grant({ ...denied, sheetLiveness: 'deleted' })
        const deleted = await route.send(request(pinned.url()))
        expect(live.status).toBe(403)
        expect(deleted.status).toBe(403)
        expect(deleted.body).toEqual(live.body)

        grant({ userId: '', sheetLiveness: 'deleted' })
        const anonymous = await route.send(request(pinned.url()))
        expect(anonymous.status).toBe(401)
        untouched()
      })

      it('live sheet → the gate lets the request through (positive control)', async () => {
        mocks.loadFieldsForSheet.mockClear()
        grant({ sheetLiveness: 'live' })
        const res = await route.send(request(pinned.url()))
        expect(res.body?.error?.code).not.toBe(SHEET_DELETED_CODE)
        const reachedService = spies.some((spy) => spy.mock.calls.length > 0)
        const reachedFieldRead = mocks.loadFieldsForSheet.mock.calls.length > 0
        expect(reachedService || reachedFieldRead).toBe(true)
      })
    })
  }
})
