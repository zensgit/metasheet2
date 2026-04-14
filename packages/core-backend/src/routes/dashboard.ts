/**
 * Dashboard & Chart REST API routes.
 *
 * Endpoints:
 *   Charts:
 *     GET    /api/multitable/:sheetId/charts
 *     POST   /api/multitable/:sheetId/charts
 *     GET    /api/multitable/:sheetId/charts/:id
 *     PATCH  /api/multitable/:sheetId/charts/:id
 *     DELETE /api/multitable/:sheetId/charts/:id
 *     GET    /api/multitable/:sheetId/charts/:id/data
 *
 *   Dashboards:
 *     GET    /api/multitable/:sheetId/dashboards
 *     POST   /api/multitable/:sheetId/dashboards
 *     GET    /api/multitable/:sheetId/dashboards/:id
 *     PATCH  /api/multitable/:sheetId/dashboards/:id
 *     DELETE /api/multitable/:sheetId/dashboards/:id
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

  /** GET /api/multitable/:sheetId/charts — list charts */
  router.get('/:sheetId/charts', (_req: Request, res: Response) => {
    try {
      const charts = dashboardService.listCharts(_req.params.sheetId)
      res.json({ items: charts })
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /** POST /api/multitable/:sheetId/charts — create chart */
  router.post('/:sheetId/charts', (req: Request, res: Response) => {
    try {
      const userId = getUserId(req)
      const chart = dashboardService.createChart(req.params.sheetId, {
        ...req.body,
        createdBy: userId,
      })
      res.status(201).json(chart)
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** GET /api/multitable/:sheetId/charts/:id — get chart config */
  router.get('/:sheetId/charts/:id', (req: Request, res: Response) => {
    const chart = dashboardService.getChart(req.params.id)
    if (!chart || chart.sheetId !== req.params.sheetId) {
      res.status(404).json({ error: 'Chart not found' })
      return
    }
    res.json(chart)
  })

  /** PATCH /api/multitable/:sheetId/charts/:id — update chart */
  router.patch('/:sheetId/charts/:id', (req: Request, res: Response) => {
    try {
      const chart = dashboardService.getChart(req.params.id)
      if (!chart || chart.sheetId !== req.params.sheetId) {
        res.status(404).json({ error: 'Chart not found' })
        return
      }
      const updated = dashboardService.updateChart(req.params.id, req.body)
      res.json(updated)
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** DELETE /api/multitable/:sheetId/charts/:id — delete chart */
  router.delete('/:sheetId/charts/:id', (req: Request, res: Response) => {
    const chart = dashboardService.getChart(req.params.id)
    if (!chart || chart.sheetId !== req.params.sheetId) {
      res.status(404).json({ error: 'Chart not found' })
      return
    }
    dashboardService.deleteChart(req.params.id)
    res.status(204).send()
  })

  /** GET /api/multitable/:sheetId/charts/:id/data — get computed chart data */
  router.get('/:sheetId/charts/:id/data', async (req: Request, res: Response) => {
    try {
      const chart = dashboardService.getChart(req.params.id)
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

  /** GET /api/multitable/:sheetId/dashboards — list dashboards */
  router.get('/:sheetId/dashboards', (req: Request, res: Response) => {
    try {
      const dashboards = dashboardService.listDashboards(req.params.sheetId)
      res.json({ items: dashboards })
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /** POST /api/multitable/:sheetId/dashboards — create dashboard */
  router.post('/:sheetId/dashboards', (req: Request, res: Response) => {
    try {
      const userId = getUserId(req)
      const dashboard = dashboardService.createDashboard({
        name: req.body.name,
        sheetId: req.params.sheetId,
        createdBy: userId,
      })
      res.status(201).json(dashboard)
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** GET /api/multitable/:sheetId/dashboards/:id — get dashboard */
  router.get('/:sheetId/dashboards/:id', (req: Request, res: Response) => {
    const dashboard = dashboardService.getDashboard(req.params.id)
    if (!dashboard || dashboard.sheetId !== req.params.sheetId) {
      res.status(404).json({ error: 'Dashboard not found' })
      return
    }
    res.json(dashboard)
  })

  /** PATCH /api/multitable/:sheetId/dashboards/:id — update dashboard */
  router.patch('/:sheetId/dashboards/:id', (req: Request, res: Response) => {
    try {
      const dashboard = dashboardService.getDashboard(req.params.id)
      if (!dashboard || dashboard.sheetId !== req.params.sheetId) {
        res.status(404).json({ error: 'Dashboard not found' })
        return
      }
      const updated = dashboardService.updateDashboard(req.params.id, req.body)
      res.json(updated)
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** DELETE /api/multitable/:sheetId/dashboards/:id — delete dashboard */
  router.delete('/:sheetId/dashboards/:id', (req: Request, res: Response) => {
    const dashboard = dashboardService.getDashboard(req.params.id)
    if (!dashboard || dashboard.sheetId !== req.params.sheetId) {
      res.status(404).json({ error: 'Dashboard not found' })
      return
    }
    dashboardService.deleteDashboard(req.params.id)
    res.status(204).send()
  })

  return router
}
