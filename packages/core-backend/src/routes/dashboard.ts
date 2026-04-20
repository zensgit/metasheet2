/**
 * Dashboard & Chart REST API routes.
 *
 * Mount point: `/api/multitable` (via index.ts).
 *
 * Endpoints:
 *   Charts:
 *     GET    /api/multitable/sheets/:sheetId/charts
 *     POST   /api/multitable/sheets/:sheetId/charts
 *     GET    /api/multitable/sheets/:sheetId/charts/:id
 *     PATCH  /api/multitable/sheets/:sheetId/charts/:id
 *     DELETE /api/multitable/sheets/:sheetId/charts/:id
 *     GET    /api/multitable/sheets/:sheetId/charts/:id/data
 *
 *   Dashboards:
 *     GET    /api/multitable/sheets/:sheetId/dashboards
 *     POST   /api/multitable/sheets/:sheetId/dashboards
 *     GET    /api/multitable/sheets/:sheetId/dashboards/:id
 *     PATCH  /api/multitable/sheets/:sheetId/dashboards/:id
 *     DELETE /api/multitable/sheets/:sheetId/dashboards/:id
 *
 * Response shapes for list endpoints:
 *   GET .../charts     → { charts: ChartConfig[] }
 *   GET .../dashboards → { dashboards: Dashboard[] }
 * These match apps/web/src/multitable/api/client.ts expectations.
 */

import type { Request, Response } from 'express'
import { Router } from 'express'
import { DashboardService } from '../multitable/dashboard-service'

const dashboardService = new DashboardService()

/** Expose the shared service for tests or external wiring. */
export function getDashboardService(): DashboardService {
  return dashboardService
}

function getUserId(req: Request): string {
  const user = (req as unknown as { user?: { id?: unknown } }).user
  const raw = user?.id ?? req.headers['x-user-id']
  return raw ? String(raw) : 'anonymous'
}

export function dashboardRouter() {
  const router = Router()

  // -----------------------------------------------------------------------
  // Chart routes
  // -----------------------------------------------------------------------

  /** GET /api/multitable/sheets/:sheetId/charts — list charts */
  router.get('/sheets/:sheetId/charts', async (req: Request, res: Response) => {
    try {
      const charts = await dashboardService.listCharts(req.params.sheetId)
      res.json({ charts })
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /** POST /api/multitable/sheets/:sheetId/charts — create chart */
  router.post('/sheets/:sheetId/charts', async (req: Request, res: Response) => {
    try {
      const userId = getUserId(req)
      const chart = await dashboardService.createChart(req.params.sheetId, {
        ...req.body,
        createdBy: userId,
      })
      res.status(201).json(chart)
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** GET /api/multitable/sheets/:sheetId/charts/:id — get chart config */
  router.get('/sheets/:sheetId/charts/:id', async (req: Request, res: Response) => {
    const chart = await dashboardService.getChart(req.params.id)
    if (!chart || chart.sheetId !== req.params.sheetId) {
      res.status(404).json({ error: 'Chart not found' })
      return
    }
    res.json(chart)
  })

  /** PATCH /api/multitable/sheets/:sheetId/charts/:id — update chart */
  router.patch('/sheets/:sheetId/charts/:id', async (req: Request, res: Response) => {
    try {
      const chart = await dashboardService.getChart(req.params.id)
      if (!chart || chart.sheetId !== req.params.sheetId) {
        res.status(404).json({ error: 'Chart not found' })
        return
      }
      const updated = await dashboardService.updateChart(req.params.id, req.body)
      res.json(updated)
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** DELETE /api/multitable/sheets/:sheetId/charts/:id — delete chart */
  router.delete('/sheets/:sheetId/charts/:id', async (req: Request, res: Response) => {
    const chart = await dashboardService.getChart(req.params.id)
    if (!chart || chart.sheetId !== req.params.sheetId) {
      res.status(404).json({ error: 'Chart not found' })
      return
    }
    await dashboardService.deleteChart(req.params.id)
    res.status(204).send()
  })

  /** GET /api/multitable/sheets/:sheetId/charts/:id/data — get computed chart data */
  router.get('/sheets/:sheetId/charts/:id/data', async (req: Request, res: Response) => {
    try {
      const chart = await dashboardService.getChart(req.params.id)
      if (!chart || chart.sheetId !== req.params.sheetId) {
        res.status(404).json({ error: 'Chart not found' })
        return
      }
      const data = await dashboardService.getChartData(req.params.id)
      res.json(data)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // -----------------------------------------------------------------------
  // Dashboard routes
  // -----------------------------------------------------------------------

  /** GET /api/multitable/sheets/:sheetId/dashboards — list dashboards */
  router.get('/sheets/:sheetId/dashboards', async (req: Request, res: Response) => {
    try {
      const dashboards = await dashboardService.listDashboards(req.params.sheetId)
      res.json({ dashboards })
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /** POST /api/multitable/sheets/:sheetId/dashboards — create dashboard */
  router.post('/sheets/:sheetId/dashboards', async (req: Request, res: Response) => {
    try {
      const userId = getUserId(req)
      const dashboard = await dashboardService.createDashboard({
        name: req.body.name,
        sheetId: req.params.sheetId,
        createdBy: userId,
      })
      res.status(201).json(dashboard)
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** GET /api/multitable/sheets/:sheetId/dashboards/:id — get dashboard */
  router.get('/sheets/:sheetId/dashboards/:id', async (req: Request, res: Response) => {
    const dashboard = await dashboardService.getDashboard(req.params.id)
    if (!dashboard || dashboard.sheetId !== req.params.sheetId) {
      res.status(404).json({ error: 'Dashboard not found' })
      return
    }
    res.json(dashboard)
  })

  /** PATCH /api/multitable/sheets/:sheetId/dashboards/:id — update dashboard */
  router.patch('/sheets/:sheetId/dashboards/:id', async (req: Request, res: Response) => {
    try {
      const dashboard = await dashboardService.getDashboard(req.params.id)
      if (!dashboard || dashboard.sheetId !== req.params.sheetId) {
        res.status(404).json({ error: 'Dashboard not found' })
        return
      }
      const updated = await dashboardService.updateDashboard(req.params.id, req.body)
      res.json(updated)
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** DELETE /api/multitable/sheets/:sheetId/dashboards/:id — delete dashboard */
  router.delete('/sheets/:sheetId/dashboards/:id', async (req: Request, res: Response) => {
    const dashboard = await dashboardService.getDashboard(req.params.id)
    if (!dashboard || dashboard.sheetId !== req.params.sheetId) {
      res.status(404).json({ error: 'Dashboard not found' })
      return
    }
    await dashboardService.deleteDashboard(req.params.id)
    res.status(204).send()
  })

  return router
}
