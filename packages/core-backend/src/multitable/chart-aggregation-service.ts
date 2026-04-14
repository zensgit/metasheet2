/**
 * Chart Aggregation Service — computes chart data from records.
 *
 * This is a pure-logic service with no DB dependency; it operates on
 * in-memory record arrays. The DashboardService is responsible for
 * fetching records and passing them here.
 */

import type { ChartConfig, ChartType, AggregationFunction } from './charts'

export interface ChartDataPoint {
  label: string
  value: number
  color?: string
}

export interface ChartData {
  chartId: string
  chartType: ChartType
  dataPoints: ChartDataPoint[]
  total?: number
  metadata?: {
    groupByField?: string
    aggregationFunction?: string
    recordCount?: number
  }
}

type RecordRow = { data: Record<string, unknown> }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

function startOfWeek(d: Date): Date {
  const day = d.getUTCDay()
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1)
  const w = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff))
  return w
}

function dateBucketKey(dateStr: string, grouping: string): string | null {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return null

  switch (grouping) {
    case 'day':
      return d.toISOString().slice(0, 10) // YYYY-MM-DD
    case 'week': {
      const w = startOfWeek(d)
      return w.toISOString().slice(0, 10)
    }
    case 'month':
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    case 'quarter': {
      const q = Math.ceil((d.getUTCMonth() + 1) / 3)
      return `${d.getUTCFullYear()}-Q${q}`
    }
    case 'year':
      return String(d.getUTCFullYear())
    default:
      return d.toISOString().slice(0, 10)
  }
}

// ---------------------------------------------------------------------------
// ChartAggregationService
// ---------------------------------------------------------------------------

export class ChartAggregationService {
  /**
   * Compute chart data from a chart config + record set.
   */
  async computeChartData(chart: ChartConfig, records: RecordRow[]): Promise<ChartData> {
    let filtered = this.filterRecords(records, chart.dataSource)
    const aggFn = chart.dataSource.aggregation.function
    const aggFieldId = chart.dataSource.aggregation.fieldId

    // Number chart: single aggregated value
    if (chart.type === 'number') {
      const allValues = filtered.map((r) => r.data[aggFieldId ?? ''])
      const value = this.aggregate(allValues, aggFn)
      return {
        chartId: chart.id,
        chartType: chart.type,
        dataPoints: [{ label: chart.display.title ?? chart.name, value }],
        total: value,
        metadata: {
          aggregationFunction: aggFn,
          recordCount: filtered.length,
        },
      }
    }

    // Group records
    let groups: Map<string, RecordRow[]>

    if (chart.dataSource.dateFieldId && chart.dataSource.dateGrouping) {
      groups = this.groupByDate(filtered, chart.dataSource.dateFieldId, chart.dataSource.dateGrouping)
    } else if (chart.dataSource.groupByFieldId) {
      groups = this.groupRecords(filtered, chart.dataSource.groupByFieldId)
    } else {
      // No grouping: everything in one bucket
      groups = new Map([['All', filtered]])
    }

    // Compute data points
    let dataPoints: ChartDataPoint[] = []
    for (const [label, groupRecords] of groups) {
      const values = groupRecords.map((r) => r.data[aggFieldId ?? ''])
      const value = this.aggregate(values, aggFn)
      dataPoints.push({ label, value })
    }

    // Sort
    dataPoints = this.sortDataPoints(dataPoints, chart.dataSource.sortBy, chart.dataSource.sortOrder)

    // Limit
    if (chart.dataSource.limit && chart.dataSource.limit > 0) {
      dataPoints = dataPoints.slice(0, chart.dataSource.limit)
    }

    const total = dataPoints.reduce((sum, dp) => sum + dp.value, 0)

    return {
      chartId: chart.id,
      chartType: chart.type,
      dataPoints,
      total,
      metadata: {
        groupByField: chart.dataSource.groupByFieldId ?? chart.dataSource.dateFieldId,
        aggregationFunction: aggFn,
        recordCount: filtered.length,
      },
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private aggregate(values: unknown[], fn: AggregationFunction): number {
    switch (fn) {
      case 'count':
        return values.length

      case 'count_distinct': {
        const set = new Set<string>()
        for (const v of values) {
          if (v != null) set.add(String(v))
        }
        return set.size
      }

      case 'sum': {
        let total = 0
        for (const v of values) {
          const n = toNumber(v)
          if (n !== null) total += n
        }
        return total
      }

      case 'avg': {
        let total = 0
        let count = 0
        for (const v of values) {
          const n = toNumber(v)
          if (n !== null) {
            total += n
            count++
          }
        }
        return count === 0 ? 0 : total / count
      }

      case 'min': {
        let min: number | null = null
        for (const v of values) {
          const n = toNumber(v)
          if (n !== null && (min === null || n < min)) min = n
        }
        return min ?? 0
      }

      case 'max': {
        let max: number | null = null
        for (const v of values) {
          const n = toNumber(v)
          if (n !== null && (max === null || n > max)) max = n
        }
        return max ?? 0
      }

      default:
        return 0
    }
  }

  private groupRecords(records: RecordRow[], fieldId: string): Map<string, RecordRow[]> {
    const groups = new Map<string, RecordRow[]>()
    for (const record of records) {
      const rawValue = record.data[fieldId]
      const key = rawValue != null ? String(rawValue) : '(empty)'
      const group = groups.get(key)
      if (group) {
        group.push(record)
      } else {
        groups.set(key, [record])
      }
    }
    return groups
  }

  private groupByDate(
    records: RecordRow[],
    dateFieldId: string,
    dateGrouping: string,
  ): Map<string, RecordRow[]> {
    const groups = new Map<string, RecordRow[]>()
    for (const record of records) {
      const rawValue = record.data[dateFieldId]
      if (rawValue == null) continue
      const key = dateBucketKey(String(rawValue), dateGrouping)
      if (key === null) continue
      const group = groups.get(key)
      if (group) {
        group.push(record)
      } else {
        groups.set(key, [record])
      }
    }
    return groups
  }

  private filterRecords(
    records: RecordRow[],
    dataSource: ChartConfig['dataSource'],
  ): RecordRow[] {
    const { filterFieldId, filterOperator, filterValue } = dataSource
    if (!filterFieldId || !filterOperator) return records

    return records.filter((r) => {
      const val = r.data[filterFieldId]
      switch (filterOperator) {
        case 'equals':
          return val != null && String(val) === String(filterValue)
        case 'not_equals':
          return val == null || String(val) !== String(filterValue)
        case 'contains':
          return val != null && String(val).includes(String(filterValue))
        case 'greater_than': {
          const n = toNumber(val)
          const t = toNumber(filterValue)
          return n !== null && t !== null && n > t
        }
        case 'less_than': {
          const n = toNumber(val)
          const t = toNumber(filterValue)
          return n !== null && t !== null && n < t
        }
        default:
          return true
      }
    })
  }

  private sortDataPoints(
    dataPoints: ChartDataPoint[],
    sortBy?: 'label' | 'value',
    sortOrder?: 'asc' | 'desc',
  ): ChartDataPoint[] {
    if (!sortBy) return dataPoints
    const dir = sortOrder === 'desc' ? -1 : 1
    return [...dataPoints].sort((a, b) => {
      if (sortBy === 'value') return (a.value - b.value) * dir
      return a.label.localeCompare(b.label) * dir
    })
  }
}
