/**
 * Dashboard Service — in-memory CRUD for charts and dashboards (V1).
 *
 * Persistence is intentionally in-memory for V1; a future version will
 * use Postgres. The service delegates aggregation to ChartAggregationService.
 */

import { randomUUID } from 'crypto'

import type { ChartConfig, ChartCreateInput } from './charts'
import type {
  Dashboard,
  DashboardCreateInput,
  DashboardUpdateInput,
} from './dashboard'
import { ChartAggregationService } from './chart-aggregation-service'
import type { ChartData } from './chart-aggregation-service'

export type RecordProvider = (sheetId: string) => Promise<Array<{ data: Record<string, unknown> }>>

export class DashboardService {
  private dashboards: Map<string, Dashboard> = new Map()
  private charts: Map<string, ChartConfig> = new Map()
  private aggregationService = new ChartAggregationService()
  private recordProvider: RecordProvider | undefined

  /**
   * Optionally inject a record provider that fetches records for a sheet.
   * If not set, `getChartData` will return empty data.
   */
  setRecordProvider(provider: RecordProvider): void {
    this.recordProvider = provider
  }

  // -----------------------------------------------------------------------
  // Chart CRUD
  // -----------------------------------------------------------------------

  createChart(sheetId: string, input: ChartCreateInput): ChartConfig {
    const id = `chart_${randomUUID()}`
    const now = new Date().toISOString()
    const chart: ChartConfig = {
      id,
      name: input.name,
      type: input.type,
      sheetId,
      viewId: input.viewId,
      dataSource: input.dataSource,
      display: input.display ?? {},
      createdBy: input.createdBy ?? 'system',
      createdAt: now,
    }
    this.charts.set(id, chart)
    return chart
  }

  getChart(chartId: string): ChartConfig | undefined {
    return this.charts.get(chartId)
  }

  listCharts(sheetId: string): ChartConfig[] {
    return Array.from(this.charts.values()).filter((c) => c.sheetId === sheetId)
  }

  updateChart(chartId: string, input: Partial<ChartConfig>): ChartConfig {
    const existing = this.charts.get(chartId)
    if (!existing) throw new Error(`Chart not found: ${chartId}`)
    const updated: ChartConfig = {
      ...existing,
      ...input,
      id: existing.id, // prevent id overwrite
      sheetId: existing.sheetId,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }
    this.charts.set(chartId, updated)
    return updated
  }

  deleteChart(chartId: string): void {
    this.charts.delete(chartId)
    // Also remove from any dashboard panels
    for (const dashboard of this.dashboards.values()) {
      dashboard.panels = dashboard.panels.filter((p) => p.chartId !== chartId)
    }
  }

  // -----------------------------------------------------------------------
  // Dashboard CRUD
  // -----------------------------------------------------------------------

  createDashboard(input: DashboardCreateInput): Dashboard {
    const id = `dash_${randomUUID()}`
    const now = new Date().toISOString()
    const dashboard: Dashboard = {
      id,
      name: input.name,
      sheetId: input.sheetId,
      panels: [],
      createdBy: input.createdBy ?? 'system',
      createdAt: now,
    }
    this.dashboards.set(id, dashboard)
    return dashboard
  }

  getDashboard(dashboardId: string): Dashboard | undefined {
    return this.dashboards.get(dashboardId)
  }

  listDashboards(sheetId: string): Dashboard[] {
    return Array.from(this.dashboards.values()).filter((d) => d.sheetId === sheetId)
  }

  updateDashboard(dashboardId: string, input: DashboardUpdateInput): Dashboard {
    const existing = this.dashboards.get(dashboardId)
    if (!existing) throw new Error(`Dashboard not found: ${dashboardId}`)
    const updated: Dashboard = {
      ...existing,
      name: input.name ?? existing.name,
      panels: input.panels ?? existing.panels,
      updatedAt: new Date().toISOString(),
    }
    this.dashboards.set(dashboardId, updated)
    return updated
  }

  deleteDashboard(dashboardId: string): void {
    this.dashboards.delete(dashboardId)
  }

  // -----------------------------------------------------------------------
  // Chart data computation
  // -----------------------------------------------------------------------

  async getChartData(chartId: string): Promise<ChartData> {
    const chart = this.charts.get(chartId)
    if (!chart) throw new Error(`Chart not found: ${chartId}`)

    let records: Array<{ data: Record<string, unknown> }> = []
    if (this.recordProvider) {
      records = await this.recordProvider(chart.sheetId)
    }

    return this.aggregationService.computeChartData(chart, records)
  }
}
