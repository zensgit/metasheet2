/**
 * Dashboard Service — V2 (PostgreSQL-backed)
 *
 * Replaces in-memory Maps with Kysely queries against
 * multitable_charts and multitable_dashboards tables.
 * Aggregation still delegates to ChartAggregationService.
 */

import { randomUUID } from 'crypto'

import type { ChartConfig, ChartCreateInput } from './charts'
import type {
  Dashboard,
  DashboardCreateInput,
  DashboardPanel,
  DashboardUpdateInput,
} from './dashboard'
import { ChartAggregationService } from './chart-aggregation-service'
import type { ChartData } from './chart-aggregation-service'
import { db } from '../db/db'

export type RecordProvider = (sheetId: string) => Promise<Array<{ data: Record<string, unknown> }>>

export class DashboardService {
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

  async createChart(sheetId: string, input: ChartCreateInput): Promise<ChartConfig> {
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

    await db
      .insertInto('multitable_charts')
      .values({
        id: chart.id,
        name: chart.name,
        type: chart.type,
        sheet_id: chart.sheetId,
        view_id: chart.viewId ?? null,
        data_source: JSON.stringify(chart.dataSource),
        display: JSON.stringify(chart.display),
        created_by: chart.createdBy,
      })
      .execute()

    return chart
  }

  async getChart(chartId: string): Promise<ChartConfig | undefined> {
    const row = await db
      .selectFrom('multitable_charts')
      .selectAll()
      .where('id', '=', chartId)
      .executeTakeFirst()

    return row ? toChartConfig(row) : undefined
  }

  async listCharts(sheetId: string): Promise<ChartConfig[]> {
    const rows = await db
      .selectFrom('multitable_charts')
      .selectAll()
      .where('sheet_id', '=', sheetId)
      .execute()

    return rows.map(toChartConfig)
  }

  async updateChart(chartId: string, input: Partial<ChartConfig>): Promise<ChartConfig> {
    const existing = await this.getChart(chartId)
    if (!existing) throw new Error(`Chart not found: ${chartId}`)

    const updated: ChartConfig = {
      ...existing,
      ...input,
      id: existing.id,
      sheetId: existing.sheetId,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }

    await db
      .updateTable('multitable_charts')
      .set({
        name: updated.name,
        type: updated.type,
        view_id: updated.viewId ?? null,
        data_source: JSON.stringify(updated.dataSource),
        display: JSON.stringify(updated.display),
      })
      .where('id', '=', chartId)
      .execute()

    return updated
  }

  async deleteChart(chartId: string): Promise<void> {
    await db
      .deleteFrom('multitable_charts')
      .where('id', '=', chartId)
      .execute()

    // Also remove from any dashboard panels
    const dashboards = await db
      .selectFrom('multitable_dashboards')
      .selectAll()
      .execute()

    for (const dash of dashboards) {
      const panels = (typeof dash.panels === 'string'
        ? JSON.parse(dash.panels)
        : dash.panels) as DashboardPanel[]
      const filtered = panels.filter((p) => p.chartId !== chartId)
      if (filtered.length !== panels.length) {
        await db
          .updateTable('multitable_dashboards')
          .set({
            panels: JSON.stringify(filtered),
          })
          .where('id', '=', dash.id)
          .execute()
      }
    }
  }

  // -----------------------------------------------------------------------
  // Dashboard CRUD
  // -----------------------------------------------------------------------

  async createDashboard(input: DashboardCreateInput): Promise<Dashboard> {
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

    await db
      .insertInto('multitable_dashboards')
      .values({
        id: dashboard.id,
        name: dashboard.name,
        sheet_id: dashboard.sheetId,
        panels: JSON.stringify(dashboard.panels),
        created_by: dashboard.createdBy,
      })
      .execute()

    return dashboard
  }

  async getDashboard(dashboardId: string): Promise<Dashboard | undefined> {
    const row = await db
      .selectFrom('multitable_dashboards')
      .selectAll()
      .where('id', '=', dashboardId)
      .executeTakeFirst()

    return row ? toDashboard(row) : undefined
  }

  async listDashboards(sheetId: string): Promise<Dashboard[]> {
    const rows = await db
      .selectFrom('multitable_dashboards')
      .selectAll()
      .where('sheet_id', '=', sheetId)
      .execute()

    return rows.map(toDashboard)
  }

  async updateDashboard(dashboardId: string, input: DashboardUpdateInput): Promise<Dashboard> {
    const existing = await this.getDashboard(dashboardId)
    if (!existing) throw new Error(`Dashboard not found: ${dashboardId}`)

    const updated: Dashboard = {
      ...existing,
      name: input.name ?? existing.name,
      panels: input.panels ?? existing.panels,
      updatedAt: new Date().toISOString(),
    }

    await db
      .updateTable('multitable_dashboards')
      .set({
        name: updated.name,
        panels: JSON.stringify(updated.panels),
      })
      .where('id', '=', dashboardId)
      .execute()

    return updated
  }

  async deleteDashboard(dashboardId: string): Promise<void> {
    await db
      .deleteFrom('multitable_dashboards')
      .where('id', '=', dashboardId)
      .execute()
  }

  // -----------------------------------------------------------------------
  // Chart data computation
  // -----------------------------------------------------------------------

  async getChartData(chartId: string): Promise<ChartData> {
    const chart = await this.getChart(chartId)
    if (!chart) throw new Error(`Chart not found: ${chartId}`)

    let records: Array<{ data: Record<string, unknown> }> = []
    if (this.recordProvider) {
      records = await this.recordProvider(chart.sheetId)
    }

    return this.aggregationService.computeChartData(chart, records)
  }
}

// ── Row-to-domain mappers ───────────────────────────────────────────────────

function toChartConfig(row: Record<string, unknown>): ChartConfig {
  const dataSource = typeof row.data_source === 'string'
    ? JSON.parse(row.data_source)
    : row.data_source
  const display = typeof row.display === 'string'
    ? JSON.parse(row.display)
    : row.display
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as ChartConfig['type'],
    sheetId: row.sheet_id as string,
    viewId: (row.view_id as string) ?? undefined,
    dataSource,
    display: display ?? {},
    createdBy: row.created_by as string,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    updatedAt: row.updated_at
      ? row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at)
      : undefined,
  }
}

function toDashboard(row: Record<string, unknown>): Dashboard {
  const panels = typeof row.panels === 'string'
    ? JSON.parse(row.panels)
    : row.panels
  return {
    id: row.id as string,
    name: row.name as string,
    sheetId: row.sheet_id as string,
    panels: panels ?? [],
    createdBy: row.created_by as string,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    updatedAt: row.updated_at
      ? row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at)
      : undefined,
  }
}
