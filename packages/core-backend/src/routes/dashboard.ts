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
import { randomUUID } from 'crypto'
import { poolManager } from '../integration/db/connection-pool'
import type { MultitableCapabilities } from '../multitable/access'
import type { AggregationFunction, ChartConfig, ChartCreateInput, ChartType } from '../multitable/charts'
import type { ChartData } from '../multitable/chart-aggregation-service'
import { DashboardService } from '../multitable/dashboard-service'
import type { MultitableField } from '../multitable/field-codecs'
import { loadFieldsForSheet } from '../multitable/loaders'
import { deriveFieldPermissions, isFieldPermissionHidden } from '../multitable/permission-derivation'
import {
  loadFieldPermissionScopeMap,
  resolveSheetCapabilities,
  resolveSheetReadableCapabilities,
  type QueryFn,
} from '../multitable/permission-service'

const dashboardService = new DashboardService()
const CHART_TYPES = new Set<ChartType>(['bar', 'line', 'pie', 'number', 'table'])
const AGGREGATION_FUNCTIONS = new Set<AggregationFunction>(['count', 'sum', 'avg', 'min', 'max', 'count_distinct'])
const AGGREGATIONS_REQUIRING_FIELD = new Set<AggregationFunction>(['sum', 'avg', 'min', 'max', 'count_distinct'])
const DATE_GROUPINGS = new Set(['day', 'week', 'month', 'quarter', 'year'])

/** Expose the shared service for tests or external wiring. */
export function getDashboardService(): DashboardService {
  return dashboardService
}

function getQuery(): QueryFn {
  const pool = poolManager.get()
  return pool.query.bind(pool) as QueryFn
}

function sendUnauthorized(res: Response): void {
  res.status(401).json({
    error: {
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    },
  })
}

function sendForbidden(res: Response): void {
  res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: 'Forbidden',
    },
  })
}

type SheetAuthContext = {
  query: QueryFn
  userId: string
  capabilities: MultitableCapabilities
}

async function requireSheetRead(
  req: Request,
  res: Response,
  sheetId: string,
): Promise<SheetAuthContext | null> {
  const query = getQuery()
  const { access, capabilities } = await resolveSheetReadableCapabilities(req, query, sheetId)
  if (!access.userId) {
    sendUnauthorized(res)
    return null
  }
  if (!capabilities.canRead) {
    sendForbidden(res)
    return null
  }
  return { query, userId: access.userId, capabilities }
}

async function requireSheetManageViews(
  req: Request,
  res: Response,
  sheetId: string,
): Promise<SheetAuthContext | null> {
  const query = getQuery()
  const { access, capabilities } = await resolveSheetCapabilities(req, query, sheetId)
  if (!access.userId) {
    sendUnauthorized(res)
    return null
  }
  if (!capabilities.canManageViews) {
    sendForbidden(res)
    return null
  }
  return { query, userId: access.userId, capabilities }
}

function filterVisiblePropertyFields(fields: MultitableField[]): MultitableField[] {
  return fields.filter((field) => !isFieldPermissionHidden(field))
}

async function loadAllowedFieldIds(
  query: QueryFn,
  sheetId: string,
  userId: string,
  capabilities: MultitableCapabilities,
): Promise<Set<string>> {
  const [fields, fieldScopeMap] = await Promise.all([
    loadFieldsForSheet(query, sheetId),
    loadFieldPermissionScopeMap(query, sheetId, userId),
  ])
  const visibleFields = filterVisiblePropertyFields(fields)
  const fieldPermissions = deriveFieldPermissions(visibleFields, capabilities, {
    hiddenFieldIds: [],
    fieldScopeMap,
  })
  return new Set(
    visibleFields
      .filter((field) => fieldPermissions[field.id]?.visible !== false)
      .map((field) => field.id),
  )
}

function chartReferencedFieldIds(chart: ChartConfig): string[] {
  const source = chart.dataSource
  const ids = [
    source.aggregation.fieldId,
    source.groupByFieldId,
    source.dateFieldId,
    source.filterFieldId,
  ]
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
}

function isChartDataRestricted(chart: ChartConfig, allowedFieldIds: Set<string>): boolean {
  return chartReferencedFieldIds(chart).some((fieldId) => !allowedFieldIds.has(fieldId))
}

function restrictedChartData(chart: ChartConfig): ChartData {
  return {
    chartId: chart.id,
    chartType: chart.type,
    dataPoints: [],
    total: 0,
    metadata: {
      restricted: true,
      recordCount: 0,
    },
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function buildPreviewChart(sheetId: string, userId: string, body: unknown): ChartConfig {
  const input = (body ?? {}) as Partial<ChartCreateInput> & {
    chartType?: unknown
    type?: unknown
    displayConfig?: unknown
    display?: unknown
  }
  const chartType = readString(input.type) ?? readString(input.chartType)
  if (!chartType || !CHART_TYPES.has(chartType as ChartType)) {
    throw new Error('Invalid chart type')
  }
  const source = input.dataSource
  if (!source || typeof source !== 'object') {
    throw new Error('dataSource is required')
  }
  const aggregation = (source as ChartConfig['dataSource']).aggregation
  if (!aggregation || typeof aggregation !== 'object') {
    throw new Error('aggregation is required')
  }
  const aggregationFunction = readString(aggregation.function)
  if (!aggregationFunction || !AGGREGATION_FUNCTIONS.has(aggregationFunction as AggregationFunction)) {
    throw new Error('Invalid aggregation function')
  }
  const dateFieldId = readString((source as ChartConfig['dataSource']).dateFieldId)
  const dateGrouping = readString((source as ChartConfig['dataSource']).dateGrouping)
  const groupByFieldId = readString((source as ChartConfig['dataSource']).groupByFieldId)
  if (dateGrouping && !DATE_GROUPINGS.has(dateGrouping)) {
    throw new Error('Invalid date grouping')
  }
  if ((!dateFieldId || !dateGrouping) && !groupByFieldId) {
    throw new Error('groupByFieldId or date grouping is required')
  }
  if (AGGREGATIONS_REQUIRING_FIELD.has(aggregationFunction as AggregationFunction) && !readString(aggregation.fieldId)) {
    throw new Error('value field is required for this aggregation')
  }
  const now = new Date().toISOString()
  return {
    id: `chart_preview_${randomUUID()}`,
    name: readString(input.name) ?? 'Preview chart',
    type: chartType as ChartType,
    sheetId,
    viewId: readString(input.viewId),
    dataSource: source as ChartConfig['dataSource'],
    display: (input.display ?? input.displayConfig ?? {}) as ChartConfig['display'],
    createdBy: userId,
    createdAt: now,
  }
}

export function dashboardRouter() {
  const router = Router()

  // -----------------------------------------------------------------------
  // Chart routes
  // -----------------------------------------------------------------------

  /** GET /api/multitable/sheets/:sheetId/charts — list charts */
  router.get('/sheets/:sheetId/charts', async (req: Request, res: Response) => {
    try {
      const auth = await requireSheetRead(req, res, req.params.sheetId)
      if (!auth) return
      const charts = await dashboardService.listCharts(req.params.sheetId)
      res.json({ charts })
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /** POST /api/multitable/sheets/:sheetId/charts — create chart */
  router.post('/sheets/:sheetId/charts', async (req: Request, res: Response) => {
    try {
      const auth = await requireSheetManageViews(req, res, req.params.sheetId)
      if (!auth) return
      const chart = await dashboardService.createChart(req.params.sheetId, {
        ...req.body,
        createdBy: auth.userId,
      })
      res.status(201).json(chart)
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** POST /api/multitable/sheets/:sheetId/charts/preview-data — compute unsaved chart preview data */
  router.post('/sheets/:sheetId/charts/preview-data', async (req: Request, res: Response) => {
    try {
      const auth = await requireSheetRead(req, res, req.params.sheetId)
      if (!auth) return
      const chart = buildPreviewChart(req.params.sheetId, auth.userId, req.body)
      const allowedFieldIds = await loadAllowedFieldIds(
        auth.query,
        req.params.sheetId,
        auth.userId,
        auth.capabilities,
      )
      if (isChartDataRestricted(chart, allowedFieldIds)) {
        res.json(restrictedChartData(chart))
        return
      }
      const data = await dashboardService.computeChartDataForConfig(chart)
      res.json(data)
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** GET /api/multitable/sheets/:sheetId/charts/:id — get chart config */
  router.get('/sheets/:sheetId/charts/:id', async (req: Request, res: Response) => {
    try {
      const auth = await requireSheetRead(req, res, req.params.sheetId)
      if (!auth) return
      const chart = await dashboardService.getChart(req.params.id)
      if (!chart || chart.sheetId !== req.params.sheetId) {
        res.status(404).json({ error: 'Chart not found' })
        return
      }
      res.json(chart)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /** PATCH /api/multitable/sheets/:sheetId/charts/:id — update chart */
  router.patch('/sheets/:sheetId/charts/:id', async (req: Request, res: Response) => {
    try {
      const auth = await requireSheetManageViews(req, res, req.params.sheetId)
      if (!auth) return
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
    try {
      const auth = await requireSheetManageViews(req, res, req.params.sheetId)
      if (!auth) return
      const chart = await dashboardService.getChart(req.params.id)
      if (!chart || chart.sheetId !== req.params.sheetId) {
        res.status(404).json({ error: 'Chart not found' })
        return
      }
      await dashboardService.deleteChart(req.params.id)
      res.status(204).send()
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /** GET /api/multitable/sheets/:sheetId/charts/:id/data — get computed chart data */
  router.get('/sheets/:sheetId/charts/:id/data', async (req: Request, res: Response) => {
    try {
      const auth = await requireSheetRead(req, res, req.params.sheetId)
      if (!auth) return
      const chart = await dashboardService.getChart(req.params.id)
      if (!chart || chart.sheetId !== req.params.sheetId) {
        res.status(404).json({ error: 'Chart not found' })
        return
      }
      const allowedFieldIds = await loadAllowedFieldIds(
        auth.query,
        req.params.sheetId,
        auth.userId,
        auth.capabilities,
      )
      if (isChartDataRestricted(chart, allowedFieldIds)) {
        res.json(restrictedChartData(chart))
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
      const auth = await requireSheetRead(req, res, req.params.sheetId)
      if (!auth) return
      const dashboards = await dashboardService.listDashboards(req.params.sheetId)
      res.json({ dashboards })
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /** POST /api/multitable/sheets/:sheetId/dashboards — create dashboard */
  router.post('/sheets/:sheetId/dashboards', async (req: Request, res: Response) => {
    try {
      const auth = await requireSheetManageViews(req, res, req.params.sheetId)
      if (!auth) return
      const dashboard = await dashboardService.createDashboard({
        name: req.body.name,
        sheetId: req.params.sheetId,
        createdBy: auth.userId,
      })
      res.status(201).json(dashboard)
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** GET /api/multitable/sheets/:sheetId/dashboards/:id — get dashboard */
  router.get('/sheets/:sheetId/dashboards/:id', async (req: Request, res: Response) => {
    try {
      const auth = await requireSheetRead(req, res, req.params.sheetId)
      if (!auth) return
      const dashboard = await dashboardService.getDashboard(req.params.id)
      if (!dashboard || dashboard.sheetId !== req.params.sheetId) {
        res.status(404).json({ error: 'Dashboard not found' })
        return
      }
      res.json(dashboard)
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /** PATCH /api/multitable/sheets/:sheetId/dashboards/:id — update dashboard */
  router.patch('/sheets/:sheetId/dashboards/:id', async (req: Request, res: Response) => {
    try {
      const auth = await requireSheetManageViews(req, res, req.params.sheetId)
      if (!auth) return
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
    try {
      const auth = await requireSheetManageViews(req, res, req.params.sheetId)
      if (!auth) return
      const dashboard = await dashboardService.getDashboard(req.params.id)
      if (!dashboard || dashboard.sheetId !== req.params.sheetId) {
        res.status(404).json({ error: 'Dashboard not found' })
        return
      }
      await dashboardService.deleteDashboard(req.params.id)
      res.status(204).send()
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
