/**
 * Chart Aggregation Service — computes chart data from records.
 *
 * This is a pure-logic service with no DB dependency; it operates on
 * in-memory record arrays. The DashboardService is responsible for
 * fetching records and passing them here.
 */

import type { ChartConfig, ChartType, AggregationFunction } from './charts'
import { ADDITIVE_AGGREGATIONS } from './charts'

export interface ChartDataPoint {
  label: string
  value: number
  color?: string
  // r12 scatter: a per-record point carries its own x/y (and optional size) instead of an aggregated
  // `value`. These stay OPTIONAL so the grouped {label,value} types are byte-unchanged; only scatter
  // dataPoints populate them. `label` then holds the optional color category (empty when unset).
  xValue?: number
  yValue?: number
  size?: number
}

/**
 * v2-d bar/line series. `data` is dense and aligned POSITIONALLY to `ChartData.dataPoints` (same
 * length, same order; `0` where a (bucket × series) cell has no rows). Present for a bar or line chart
 * with `seriesByFieldId` + a primary axis (`groupByFieldId` or a date axis); a stacked bar additionally
 * requires an additive aggregation, while grouped bar / multi-series line accept any aggregation.
 */
export interface ChartSeries {
  name: string
  data: number[]
}

export interface ChartData {
  chartId: string
  chartType: ChartType
  dataPoints: ChartDataPoint[]
  /** v2-d: series split (stacked/grouped bar or multi-series line). `dataPoints`/`total` are unchanged by its presence. */
  series?: ChartSeries[]
  total?: number
  metadata?: {
    groupByField?: string
    seriesByField?: string
    aggregationFunction?: string
    recordCount?: number
    restricted?: boolean
  }
}

type RecordRow = { data: Record<string, unknown> }

/**
 * B4 dashboard-level filter: one (field, value) equals-constraint chosen in a dashboard filter widget.
 * Applied to EVERY data panel's record set BEFORE aggregation (AND-combined with each chart's own
 * `filterRecords`). Equals-only by design — the widget surfaces a single chosen value, mirroring the
 * chart's own `equals` operator coercion exactly (`String(val) === String(value)`).
 */
export interface DashboardFilter {
  fieldId: string
  value: unknown
}

/** Shared equals matcher — the exact coercion `filterRecords`' `equals` branch uses, factored so the
 *  dashboard pre-filter and the chart's own filter agree byte-for-byte (a null/absent field never matches). */
function recordMatchesEquals(data: Record<string, unknown>, fieldId: string, value: unknown): boolean {
  const val = data[fieldId]
  return val != null && String(val) === String(value)
}

/**
 * B4: narrow an ALREADY-masked / row-denied record set by the active dashboard filter(s) BEFORE it
 * reaches the aggregation engine. AND-combines all filters; an empty list is a pass-through (no
 * constraint, the "All" selection). Operates ONLY on the caller's pre-loaded `loadChartRecords`
 * output — it never queries — so it inherits the field-mask + row-level read-deny already applied and
 * cannot widen the visible set or leak a denied field's value. A filter on a field absent from the
 * masked `data` (e.g. a denied field that was projected out) matches nothing → the route's restricted
 * gate must reject such a filter UP FRONT so this never silently empties a chart instead.
 */
export function applyDashboardFilter(records: RecordRow[], filters: DashboardFilter[]): RecordRow[] {
  if (filters.length === 0) return records
  return records.filter((r) => filters.every((f) => recordMatchesEquals(r.data, f.fieldId, f.value)))
}

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
    const filtered = this.filterRecords(records, chart.dataSource)
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

    // r12 scatter: a PER-RECORD x/y projection — NOT a grouped aggregation. Branch out BEFORE the
    // grouped pipeline so that path stays byte-identical; scatter has no groupBy/aggregation/series.
    if (chart.type === 'scatter') {
      return this.computeScatterData(chart, filtered)
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

    // Sort. v2-d-b3: a date primary axis is ordered CHRONOLOGICALLY (bucket keys — day YYYY-MM-DD /
    // week / month YYYY-MM / quarter YYYY-Qn / year — sort ascending lexically = chronologically) and
    // IGNORES sortBy/sortOrder (which sort categories by label/value, meaningless for a time axis).
    // Applies to ALL date-grouped charts (single- and multi-series), fixing the old encounter-order quirk.
    const dateGrouped = !!(chart.dataSource.dateFieldId && chart.dataSource.dateGrouping)
    if (dateGrouped) {
      dataPoints.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    } else {
      dataPoints = this.sortDataPoints(dataPoints, chart.dataSource.sortBy, chart.dataSource.sortOrder)
    }

    // Limit. v2-d-b3: in date mode `limit` selects the NEWEST N buckets, then renders them chronological
    // ascending — slice(-limit) since dataPoints is already ascending (NOT slice(0,limit) = oldest N).
    // groupBy/pie keep top-N after sortBy.
    if (chart.dataSource.limit && chart.dataSource.limit > 0) {
      dataPoints = dateGrouped
        ? dataPoints.slice(-chart.dataSource.limit)
        : dataPoints.slice(0, chart.dataSource.limit)
    }

    const total = dataPoints.reduce((sum, dp) => sum + dp.value, 0)

    // v2-d: bar/line series split. Built AFTER sort+limit, so it only covers the surviving primary
    // buckets in their final order (building before limit would leak limited-out buckets). Emitted for
    // bar OR line (v2-d-b2) + seriesByFieldId + a primary axis = groupByFieldId OR a date axis (v2-d-b3).
    // Additive aggregation is required ONLY for a STACKED bar (its sum is the bar height); grouped bars
    // (v2-d-b1) and lines are independent → any aggregation. The producer branches on type/`barMode` — not
    // validation alone — so a persisted stacked+non-additive config still can't RENDER a misleading stack;
    // it just omits series. The series math is identical for a groupBy category or a date bucket (`groups`
    // is keyed by the same label `dataPoints` carries, so `groups.get(dp.label)` works for both).
    const seriesByFieldId = chart.dataSource.seriesByFieldId
    const grouped = chart.display.barMode === 'grouped'
    const seriesType = chart.type === 'bar' || chart.type === 'line'
    const requiresAdditive = chart.type === 'bar' && !grouped // only a stacked bar
    const hasPrimaryAxis = !!chart.dataSource.groupByFieldId || dateGrouped
    let series: ChartSeries[] | undefined
    if (
      seriesType &&
      seriesByFieldId &&
      hasPrimaryAxis &&
      (!requiresAdditive || ADDITIVE_AGGREGATIONS.has(aggFn))
    ) {
      const seriesNames: string[] = []
      const byName = new Map<string, number[]>() // series name -> data[] aligned to dataPoints
      dataPoints.forEach((dp, ci) => {
        const subGroups = this.groupRecords(groups.get(dp.label) ?? [], seriesByFieldId)
        for (const [name, subRecords] of subGroups) {
          let arr = byName.get(name)
          if (!arr) {
            arr = new Array(dataPoints.length).fill(0)
            byName.set(name, arr)
            seriesNames.push(name)
          }
          arr[ci] = this.aggregate(subRecords.map((r) => r.data[aggFieldId ?? '']), aggFn)
        }
      })
      series = seriesNames.map((name) => ({ name, data: byName.get(name) as number[] }))
    }

    return {
      chartId: chart.id,
      chartType: chart.type,
      dataPoints,
      ...(series ? { series } : {}),
      total,
      metadata: {
        groupByField: chart.dataSource.groupByFieldId ?? chart.dataSource.dateFieldId,
        ...(series ? { seriesByField: seriesByFieldId } : {}),
        aggregationFunction: aggFn,
        recordCount: filtered.length,
      },
    }
  }

  /**
   * r12 scatter: one dataPoint PER RECORD (no grouping/aggregation/sort). A record is included only
   * when BOTH x and y parse to finite numbers (a scatter point with a missing axis is meaningless);
   * `label` carries the optional color category (`colorFieldId`, stringified — '' when unset), and
   * `size` the optional bubble size (`sizeFieldId`, finite-numeric or omitted). `limit` caps the point
   * count (records are taken in encounter order — scatter has no value to sort by). `total` is omitted
   * (a sum of scattered y-values is meaningless); `metadata.recordCount` reports the matched records.
   */
  private computeScatterData(chart: ChartConfig, records: RecordRow[]): ChartData {
    const { xFieldId, yFieldId, colorFieldId, sizeFieldId, limit } = chart.dataSource
    const dataPoints: ChartDataPoint[] = []
    for (const record of records) {
      const xRaw = record.data[xFieldId ?? '']
      const yRaw = record.data[yFieldId ?? '']
      // Review M2: an empty string coerces to a misleading 0 — a phantom point at the axis edge.
      // For a scatter coordinate, treat '' as absent like null.
      const x = xRaw === '' ? null : toNumber(xRaw)
      const y = yRaw === '' ? null : toNumber(yRaw)
      if (x === null || y === null) continue // skip a record missing/non-numeric on either axis
      const colorRaw = colorFieldId ? record.data[colorFieldId] : undefined
      const size = sizeFieldId ? toNumber(record.data[sizeFieldId]) : null
      dataPoints.push({
        label: colorRaw != null ? String(colorRaw) : '',
        value: y, // keep `value` populated (= y) so generic {label,value} consumers degrade gracefully
        xValue: x,
        yValue: y,
        ...(size !== null ? { size } : {}),
      })
      if (limit && limit > 0 && dataPoints.length >= limit) break
    }
    return {
      chartId: chart.id,
      chartType: chart.type,
      dataPoints,
      metadata: {
        recordCount: dataPoints.length,
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
          return recordMatchesEquals(r.data, filterFieldId, filterValue)
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
