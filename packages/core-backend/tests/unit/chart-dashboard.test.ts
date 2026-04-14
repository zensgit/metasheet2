import { describe, it, expect, beforeEach, vi } from 'vitest'

import { ChartAggregationService } from '../../src/multitable/chart-aggregation-service'
import type { ChartData } from '../../src/multitable/chart-aggregation-service'
import type { ChartConfig, ChartCreateInput } from '../../src/multitable/charts'

// ── DB mock ──────────────────────────────────────────────────────────────────

const _executeResults: unknown[] = []
const _executeTakeFirstResults: unknown[] = []

function makeChain(): Record<string, unknown> {
  const self: Record<string, unknown> = {}
  const chainFn = (..._args: unknown[]) => self
  const methods = [
    'selectFrom', 'selectAll', 'select', 'where', 'orderBy',
    'limit', 'offset', 'groupBy', 'insertInto', 'values',
    'onConflict', 'columns', 'doUpdateSet',
    'updateTable', 'set', 'deleteFrom', 'returningAll',
    'leftJoin',
  ]
  for (const m of methods) {
    self[m] = vi.fn(chainFn)
  }
  self.execute = vi.fn(async () => {
    return _executeResults.shift() ?? []
  })
  self.executeTakeFirst = vi.fn(async () => {
    return _executeTakeFirstResults.shift()
  })
  return self
}

vi.mock('../../src/db/db', () => {
  const rootChain: Record<string, unknown> = {}
  for (const m of ['selectFrom', 'insertInto', 'updateTable', 'deleteFrom']) {
    rootChain[m] = vi.fn(() => makeChain())
  }
  return { db: rootChain }
})

import { DashboardService } from '../../src/multitable/dashboard-service'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecords(rows: Record<string, unknown>[]): Array<{ data: Record<string, unknown> }> {
  return rows.map((data) => ({ data }))
}

function makeChart(overrides: Partial<ChartConfig> = {}): ChartConfig {
  return {
    id: 'chart_test',
    name: 'Test Chart',
    type: 'bar',
    sheetId: 'sheet1',
    dataSource: {
      groupByFieldId: 'status',
      aggregation: { function: 'count' },
    },
    display: {},
    createdBy: 'user1',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const sampleRecords = makeRecords([
  { status: 'open', amount: 10, category: 'A', date: '2026-01-15' },
  { status: 'open', amount: 20, category: 'B', date: '2026-01-20' },
  { status: 'closed', amount: 30, category: 'A', date: '2026-02-10' },
  { status: 'closed', amount: 40, category: 'B', date: '2026-03-05' },
  { status: 'open', amount: 50, category: 'A', date: '2026-04-12' },
])

// ---------------------------------------------------------------------------
// ChartAggregationService (pure logic — unchanged)
// ---------------------------------------------------------------------------

describe('ChartAggregationService', () => {
  let service: ChartAggregationService

  beforeEach(() => {
    service = new ChartAggregationService()
  })

  // -- Aggregation functions -----------------------------------------------

  describe('aggregation: count', () => {
    it('counts records per group', async () => {
      const chart = makeChart()
      const result = await service.computeChartData(chart, sampleRecords)
      expect(result.dataPoints).toHaveLength(2)
      const open = result.dataPoints.find((dp) => dp.label === 'open')
      const closed = result.dataPoints.find((dp) => dp.label === 'closed')
      expect(open?.value).toBe(3)
      expect(closed?.value).toBe(2)
    })
  })

  describe('aggregation: sum', () => {
    it('sums numeric field values per group', async () => {
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'status',
          aggregation: { function: 'sum', fieldId: 'amount' },
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      const open = result.dataPoints.find((dp) => dp.label === 'open')
      expect(open?.value).toBe(80) // 10+20+50
    })
  })

  describe('aggregation: avg', () => {
    it('averages numeric field values per group', async () => {
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'status',
          aggregation: { function: 'avg', fieldId: 'amount' },
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      const closed = result.dataPoints.find((dp) => dp.label === 'closed')
      expect(closed?.value).toBeCloseTo(35) // (30+40)/2
    })
  })

  describe('aggregation: min', () => {
    it('finds minimum value per group', async () => {
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'status',
          aggregation: { function: 'min', fieldId: 'amount' },
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      const open = result.dataPoints.find((dp) => dp.label === 'open')
      expect(open?.value).toBe(10)
    })
  })

  describe('aggregation: max', () => {
    it('finds maximum value per group', async () => {
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'status',
          aggregation: { function: 'max', fieldId: 'amount' },
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      const open = result.dataPoints.find((dp) => dp.label === 'open')
      expect(open?.value).toBe(50)
    })
  })

  describe('aggregation: count_distinct', () => {
    it('counts unique values per group', async () => {
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'status',
          aggregation: { function: 'count_distinct', fieldId: 'category' },
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      const open = result.dataPoints.find((dp) => dp.label === 'open')
      expect(open?.value).toBe(2) // A, B
    })
  })

  // -- Grouping ------------------------------------------------------------

  describe('grouping: by text field', () => {
    it('groups by a text field', async () => {
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'category',
          aggregation: { function: 'count' },
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      expect(result.dataPoints).toHaveLength(2)
      const a = result.dataPoints.find((dp) => dp.label === 'A')
      expect(a?.value).toBe(3)
    })
  })

  describe('grouping: by select field', () => {
    it('groups by select/status field', async () => {
      const chart = makeChart()
      const result = await service.computeChartData(chart, sampleRecords)
      expect(result.dataPoints.map((dp) => dp.label).sort()).toEqual(['closed', 'open'])
    })
  })

  // -- Date grouping -------------------------------------------------------

  describe('date grouping: day', () => {
    it('buckets records by day', async () => {
      const chart = makeChart({
        type: 'line',
        dataSource: {
          dateFieldId: 'date',
          dateGrouping: 'day',
          aggregation: { function: 'count' },
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      expect(result.dataPoints.length).toBe(5) // 5 unique days
    })
  })

  describe('date grouping: month', () => {
    it('buckets records by month', async () => {
      const chart = makeChart({
        type: 'line',
        dataSource: {
          dateFieldId: 'date',
          dateGrouping: 'month',
          aggregation: { function: 'sum', fieldId: 'amount' },
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      const jan = result.dataPoints.find((dp) => dp.label === '2026-01')
      expect(jan?.value).toBe(30) // 10+20
    })
  })

  describe('date grouping: quarter', () => {
    it('buckets records by quarter', async () => {
      const chart = makeChart({
        type: 'line',
        dataSource: {
          dateFieldId: 'date',
          dateGrouping: 'quarter',
          aggregation: { function: 'count' },
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      const q1 = result.dataPoints.find((dp) => dp.label === '2026-Q1')
      expect(q1?.value).toBe(4) // Jan(2) + Feb(1) + Mar(1)
    })
  })

  describe('date grouping: year', () => {
    it('buckets records by year', async () => {
      const chart = makeChart({
        type: 'line',
        dataSource: {
          dateFieldId: 'date',
          dateGrouping: 'year',
          aggregation: { function: 'count' },
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      expect(result.dataPoints).toHaveLength(1)
      expect(result.dataPoints[0].label).toBe('2026')
      expect(result.dataPoints[0].value).toBe(5)
    })
  })

  describe('date grouping: week', () => {
    it('buckets records by ISO week start', async () => {
      const chart = makeChart({
        type: 'line',
        dataSource: {
          dateFieldId: 'date',
          dateGrouping: 'week',
          aggregation: { function: 'count' },
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      // Each date is in a different week except possibly Jan 15 & 20
      expect(result.dataPoints.length).toBeGreaterThanOrEqual(4)
    })
  })

  // -- Filtering -----------------------------------------------------------

  describe('filter: equals', () => {
    it('filters records by equals operator', async () => {
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'category',
          aggregation: { function: 'count' },
          filterFieldId: 'status',
          filterOperator: 'equals',
          filterValue: 'open',
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      const total = result.dataPoints.reduce((s, dp) => s + dp.value, 0)
      expect(total).toBe(3)
    })
  })

  describe('filter: not_equals', () => {
    it('excludes records matching value', async () => {
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'category',
          aggregation: { function: 'count' },
          filterFieldId: 'status',
          filterOperator: 'not_equals',
          filterValue: 'open',
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      const total = result.dataPoints.reduce((s, dp) => s + dp.value, 0)
      expect(total).toBe(2)
    })
  })

  describe('filter: contains', () => {
    it('filters records containing substring', async () => {
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'status',
          aggregation: { function: 'count' },
          filterFieldId: 'category',
          filterOperator: 'contains',
          filterValue: 'A',
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      const total = result.dataPoints.reduce((s, dp) => s + dp.value, 0)
      expect(total).toBe(3)
    })
  })

  describe('filter: greater_than', () => {
    it('filters numeric values greater than threshold', async () => {
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'status',
          aggregation: { function: 'count' },
          filterFieldId: 'amount',
          filterOperator: 'greater_than',
          filterValue: 25,
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      const total = result.dataPoints.reduce((s, dp) => s + dp.value, 0)
      expect(total).toBe(3) // 30, 40, 50
    })
  })

  describe('filter: less_than', () => {
    it('filters numeric values less than threshold', async () => {
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'status',
          aggregation: { function: 'count' },
          filterFieldId: 'amount',
          filterOperator: 'less_than',
          filterValue: 25,
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      const total = result.dataPoints.reduce((s, dp) => s + dp.value, 0)
      expect(total).toBe(2) // 10, 20
    })
  })

  // -- Edge cases ----------------------------------------------------------

  describe('edge case: empty records', () => {
    it('returns empty data points', async () => {
      const chart = makeChart()
      const result = await service.computeChartData(chart, [])
      expect(result.dataPoints).toHaveLength(0)
    })
  })

  describe('edge case: null values', () => {
    it('groups null values under (empty)', async () => {
      const records = makeRecords([
        { status: null, amount: 10 },
        { status: 'open', amount: 20 },
      ])
      const chart = makeChart()
      const result = await service.computeChartData(chart, records)
      const empty = result.dataPoints.find((dp) => dp.label === '(empty)')
      expect(empty?.value).toBe(1)
    })
  })

  describe('edge case: non-numeric for sum/avg', () => {
    it('skips non-numeric values in sum', async () => {
      const records = makeRecords([
        { group: 'A', val: 10 },
        { group: 'A', val: 'not-a-number' },
        { group: 'A', val: null },
        { group: 'A', val: 30 },
      ])
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'group',
          aggregation: { function: 'sum', fieldId: 'val' },
        },
      })
      const result = await service.computeChartData(chart, records)
      expect(result.dataPoints[0].value).toBe(40) // 10+30
    })

    it('returns 0 for avg when all non-numeric', async () => {
      const records = makeRecords([
        { group: 'A', val: 'text' },
        { group: 'A', val: undefined },
      ])
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'group',
          aggregation: { function: 'avg', fieldId: 'val' },
        },
      })
      const result = await service.computeChartData(chart, records)
      expect(result.dataPoints[0].value).toBe(0)
    })
  })

  describe('edge case: min/max with no numeric values', () => {
    it('returns 0 when no numeric values exist', async () => {
      const records = makeRecords([
        { group: 'A', val: 'text' },
      ])
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'group',
          aggregation: { function: 'min', fieldId: 'val' },
        },
      })
      const result = await service.computeChartData(chart, records)
      expect(result.dataPoints[0].value).toBe(0)
    })
  })

  // -- Number chart --------------------------------------------------------

  describe('number chart', () => {
    it('returns single aggregated value', async () => {
      const chart = makeChart({
        type: 'number',
        dataSource: {
          aggregation: { function: 'sum', fieldId: 'amount' },
        },
        display: { title: 'Total Revenue' },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      expect(result.dataPoints).toHaveLength(1)
      expect(result.dataPoints[0].value).toBe(150) // 10+20+30+40+50
      expect(result.dataPoints[0].label).toBe('Total Revenue')
      expect(result.total).toBe(150)
    })

    it('uses chart name when no title', async () => {
      const chart = makeChart({
        type: 'number',
        name: 'Record Count',
        dataSource: {
          aggregation: { function: 'count' },
        },
        display: {},
      })
      const result = await service.computeChartData(chart, sampleRecords)
      expect(result.dataPoints[0].label).toBe('Record Count')
      expect(result.dataPoints[0].value).toBe(5)
    })
  })

  // -- Table chart ---------------------------------------------------------

  describe('table chart', () => {
    it('returns grouped data as table rows', async () => {
      const chart = makeChart({
        type: 'table',
        dataSource: {
          groupByFieldId: 'category',
          aggregation: { function: 'sum', fieldId: 'amount' },
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      expect(result.chartType).toBe('table')
      expect(result.dataPoints.length).toBe(2)
      const a = result.dataPoints.find((dp) => dp.label === 'A')
      expect(a?.value).toBe(90) // 10+30+50
    })
  })

  // -- Sorting -------------------------------------------------------------

  describe('sorting: by label asc', () => {
    it('sorts data points by label ascending', async () => {
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'status',
          aggregation: { function: 'count' },
          sortBy: 'label',
          sortOrder: 'asc',
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      expect(result.dataPoints[0].label).toBe('closed')
      expect(result.dataPoints[1].label).toBe('open')
    })
  })

  describe('sorting: by value desc', () => {
    it('sorts data points by value descending', async () => {
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'status',
          aggregation: { function: 'count' },
          sortBy: 'value',
          sortOrder: 'desc',
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      expect(result.dataPoints[0].value).toBeGreaterThanOrEqual(result.dataPoints[1].value)
    })
  })

  describe('sorting: by value asc', () => {
    it('sorts data points by value ascending', async () => {
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'status',
          aggregation: { function: 'count' },
          sortBy: 'value',
          sortOrder: 'asc',
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      expect(result.dataPoints[0].value).toBeLessThanOrEqual(result.dataPoints[1].value)
    })
  })

  // -- Limit ---------------------------------------------------------------

  describe('limit', () => {
    it('limits the number of data points', async () => {
      const chart = makeChart({
        dataSource: {
          groupByFieldId: 'category',
          aggregation: { function: 'count' },
          sortBy: 'value',
          sortOrder: 'desc',
          limit: 1,
        },
      })
      const result = await service.computeChartData(chart, sampleRecords)
      expect(result.dataPoints).toHaveLength(1)
    })
  })

  // -- Metadata ------------------------------------------------------------

  describe('metadata', () => {
    it('includes metadata in result', async () => {
      const chart = makeChart()
      const result = await service.computeChartData(chart, sampleRecords)
      expect(result.metadata?.groupByField).toBe('status')
      expect(result.metadata?.aggregationFunction).toBe('count')
      expect(result.metadata?.recordCount).toBe(5)
    })
  })
})

// ---------------------------------------------------------------------------
// DashboardService (Kysely-backed)
// ---------------------------------------------------------------------------

describe('DashboardService', () => {
  let service: DashboardService

  beforeEach(() => {
    _executeResults.length = 0
    _executeTakeFirstResults.length = 0
    service = new DashboardService()
  })

  // -- Chart CRUD ----------------------------------------------------------

  describe('chart CRUD', () => {
    it('creates a chart', async () => {
      // insert execute
      _executeResults.push([])
      const chart = await service.createChart('sheet1', {
        name: 'My Chart',
        type: 'bar',
        dataSource: { aggregation: { function: 'count' } },
      })
      expect(chart.id).toMatch(/^chart_/)
      expect(chart.name).toBe('My Chart')
      expect(chart.sheetId).toBe('sheet1')
    })

    it('lists charts for a sheet', async () => {
      const rows = [
        { id: 'chart_1', name: 'C1', type: 'bar', sheet_id: 'sheet1', view_id: null, data_source: {}, display: {}, created_by: 'system', created_at: new Date(), updated_at: new Date() },
        { id: 'chart_2', name: 'C3', type: 'line', sheet_id: 'sheet1', view_id: null, data_source: {}, display: {}, created_by: 'system', created_at: new Date(), updated_at: new Date() },
      ]
      _executeResults.push(rows)
      const list = await service.listCharts('sheet1')
      expect(list).toHaveLength(2)
      expect(list.map((c) => c.name).sort()).toEqual(['C1', 'C3'])
    })

    it('gets a chart by id', async () => {
      _executeTakeFirstResults.push({
        id: 'chart_1', name: 'C', type: 'bar', sheet_id: 'sheet1', view_id: null,
        data_source: { aggregation: { function: 'count' } }, display: {},
        created_by: 'system', created_at: new Date(), updated_at: new Date(),
      })
      const fetched = await service.getChart('chart_1')
      expect(fetched?.id).toBe('chart_1')
    })

    it('updates a chart', async () => {
      // getChart (executeTakeFirst)
      _executeTakeFirstResults.push({
        id: 'chart_1', name: 'C', type: 'bar', sheet_id: 'sheet1', view_id: null,
        data_source: { aggregation: { function: 'count' } }, display: {},
        created_by: 'system', created_at: new Date(), updated_at: null,
      })
      // update execute
      _executeResults.push([])
      const updated = await service.updateChart('chart_1', { name: 'Updated' })
      expect(updated.name).toBe('Updated')
      expect(updated.updatedAt).toBeDefined()
      expect(updated.id).toBe('chart_1')
      expect(updated.sheetId).toBe('sheet1')
    })

    it('throws when updating non-existent chart', async () => {
      _executeTakeFirstResults.push(undefined)
      await expect(service.updateChart('no_such_id', { name: 'X' })).rejects.toThrow('Chart not found')
    })

    it('deletes a chart', async () => {
      // delete execute
      _executeResults.push([])
      // select dashboards for panel cleanup
      _executeResults.push([])
      await service.deleteChart('chart_1')
      // getChart
      _executeTakeFirstResults.push(undefined)
      const result = await service.getChart('chart_1')
      expect(result).toBeUndefined()
    })

    it('deleting a chart removes it from dashboard panels', async () => {
      // delete chart execute
      _executeResults.push([])
      // select all dashboards
      _executeResults.push([
        {
          id: 'dash_1', name: 'D', sheet_id: 'sheet1',
          panels: [{ id: 'p1', chartId: 'chart_1', position: { x: 0, y: 0, w: 6, h: 4 } }],
          created_by: 'system', created_at: new Date(), updated_at: new Date(),
        },
      ])
      // update dashboard panels execute
      _executeResults.push([])
      await service.deleteChart('chart_1')
    })
  })

  // -- Dashboard CRUD ------------------------------------------------------

  describe('dashboard CRUD', () => {
    it('creates a dashboard', async () => {
      _executeResults.push([])
      const dash = await service.createDashboard({ name: 'My Dashboard', sheetId: 'sheet1' })
      expect(dash.id).toMatch(/^dash_/)
      expect(dash.name).toBe('My Dashboard')
      expect(dash.panels).toHaveLength(0)
    })

    it('lists dashboards for a sheet', async () => {
      _executeResults.push([
        { id: 'dash_1', name: 'D1', sheet_id: 'sheet1', panels: [], created_by: 'system', created_at: new Date(), updated_at: new Date() },
      ])
      const list = await service.listDashboards('sheet1')
      expect(list).toHaveLength(1)
    })

    it('gets a dashboard by id', async () => {
      _executeTakeFirstResults.push({
        id: 'dash_1', name: 'D', sheet_id: 'sheet1', panels: [],
        created_by: 'system', created_at: new Date(), updated_at: new Date(),
      })
      const dash = await service.getDashboard('dash_1')
      expect(dash?.id).toBe('dash_1')
    })

    it('updates dashboard name', async () => {
      _executeTakeFirstResults.push({
        id: 'dash_1', name: 'D', sheet_id: 'sheet1', panels: [],
        created_by: 'system', created_at: new Date(), updated_at: null,
      })
      _executeResults.push([])
      const updated = await service.updateDashboard('dash_1', { name: 'Renamed' })
      expect(updated.name).toBe('Renamed')
      expect(updated.updatedAt).toBeDefined()
    })

    it('adds panels to a dashboard', async () => {
      _executeTakeFirstResults.push({
        id: 'dash_1', name: 'D', sheet_id: 'sheet1', panels: [],
        created_by: 'system', created_at: new Date(), updated_at: null,
      })
      _executeResults.push([])
      const updated = await service.updateDashboard('dash_1', {
        panels: [
          { id: 'p1', chartId: 'c1', position: { x: 0, y: 0, w: 6, h: 4 } },
          { id: 'p2', chartId: 'c1', position: { x: 6, y: 0, w: 6, h: 4 } },
        ],
      })
      expect(updated.panels).toHaveLength(2)
    })

    it('throws when updating non-existent dashboard', async () => {
      _executeTakeFirstResults.push(undefined)
      await expect(service.updateDashboard('no_such', { name: 'X' })).rejects.toThrow('Dashboard not found')
    })

    it('deletes a dashboard', async () => {
      _executeResults.push([])
      await service.deleteDashboard('dash_1')
      _executeTakeFirstResults.push(undefined)
      const result = await service.getDashboard('dash_1')
      expect(result).toBeUndefined()
    })
  })

  // -- Chart data computation ----------------------------------------------

  describe('chart data computation', () => {
    it('computes chart data with record provider', async () => {
      _executeTakeFirstResults.push({
        id: 'chart_1', name: 'Status Counts', type: 'bar', sheet_id: 'sheet1', view_id: null,
        data_source: { groupByFieldId: 'status', aggregation: { function: 'count' } },
        display: {}, created_by: 'system', created_at: new Date(), updated_at: new Date(),
      })
      service.setRecordProvider(async (_sheetId: string) => sampleRecords)
      const data = await service.getChartData('chart_1')
      expect(data.chartId).toBe('chart_1')
      expect(data.chartType).toBe('bar')
      expect(data.dataPoints.length).toBeGreaterThan(0)
    })

    it('returns empty data when no record provider', async () => {
      _executeTakeFirstResults.push({
        id: 'chart_2', name: 'Empty', type: 'bar', sheet_id: 'sheet1', view_id: null,
        data_source: { groupByFieldId: 'status', aggregation: { function: 'count' } },
        display: {}, created_by: 'system', created_at: new Date(), updated_at: new Date(),
      })
      const data = await service.getChartData('chart_2')
      expect(data.dataPoints).toHaveLength(0)
    })

    it('throws when chart not found', async () => {
      _executeTakeFirstResults.push(undefined)
      await expect(service.getChartData('nonexistent')).rejects.toThrow('Chart not found')
    })

    it('full pipeline: records -> filter -> group -> aggregate -> sort -> limit', async () => {
      _executeTakeFirstResults.push({
        id: 'chart_3', name: 'Top Category', type: 'pie', sheet_id: 'sheet1', view_id: null,
        data_source: {
          groupByFieldId: 'category',
          aggregation: { function: 'sum', fieldId: 'amount' },
          filterFieldId: 'status',
          filterOperator: 'equals',
          filterValue: 'open',
          sortBy: 'value',
          sortOrder: 'desc',
          limit: 1,
        },
        display: {}, created_by: 'system', created_at: new Date(), updated_at: new Date(),
      })
      service.setRecordProvider(async () => sampleRecords)
      const data = await service.getChartData('chart_3')
      expect(data.dataPoints).toHaveLength(1)
      expect(data.dataPoints[0].label).toBe('A')
      expect(data.dataPoints[0].value).toBe(60)
    })
  })
})
