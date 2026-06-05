/**
 * Chart type definitions for multitable dashboard V1.
 */

export type ChartType = 'bar' | 'line' | 'pie' | 'number' | 'table'

export type AggregationFunction = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct'

export interface ChartAggregation {
  function: AggregationFunction
  fieldId?: string // required for sum/avg/min/max, optional for count
}

export interface ChartDataSource {
  /** What to group by (X axis for bar/line, slices for pie) */
  groupByFieldId?: string

  /**
   * v2-d: split each `groupByFieldId` category into stacked series.
   * Honored only for a `bar` chart with a primary `groupByFieldId` and an additive
   * aggregation (sum/count) — see `assertSeriesConstraints`; inert / rejected otherwise.
   */
  seriesByFieldId?: string

  /** What to aggregate (Y axis for bar/line, values for pie) */
  aggregation: ChartAggregation

  /** Optional: filter records before aggregation */
  filterFieldId?: string
  filterOperator?: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than'
  filterValue?: unknown

  /** Optional: sort results */
  sortBy?: 'label' | 'value'
  sortOrder?: 'asc' | 'desc'

  /** For line charts: time field for X axis */
  dateFieldId?: string
  dateGrouping?: 'day' | 'week' | 'month' | 'quarter' | 'year'

  /** Limit number of groups/slices */
  limit?: number
}

export interface ChartDisplayConfig {
  title?: string
  showLegend?: boolean
  showValues?: boolean
  colorScheme?: string
  /** For number chart */
  prefix?: string
  suffix?: string
}

export interface ChartConfig {
  id: string
  name: string
  type: ChartType
  sheetId: string
  viewId?: string // optional: use view's filters/sorts
  dataSource: ChartDataSource
  display: ChartDisplayConfig
  createdBy: string
  createdAt: string
  updatedAt?: string
}

export interface ChartCreateInput {
  name: string
  type: ChartType
  viewId?: string
  dataSource: ChartDataSource
  display?: ChartDisplayConfig
  createdBy?: string
}

/**
 * v2-d §4: aggregations whose stacked-bar segment heights sum to a meaningful total
 * (`Σ segments == the single-series bar`). `avg`/`min`/`max`/`count_distinct` are excluded —
 * stacking them produces a misleading height (avg-of-avgs; cross-series double-counting).
 */
export const ADDITIVE_AGGREGATIONS: ReadonlySet<AggregationFunction> = new Set<AggregationFunction>([
  'sum',
  'count',
])

/**
 * v2-d stacked-series (`seriesByFieldId`) constraints. No-op when unset; otherwise throws unless
 * the chart is a `bar` with a primary `groupByFieldId` and an additive aggregation (sum/count).
 *
 * Enforced at EVERY input boundary (preview + persisted create/update) so the UI is never the sole
 * guard; the producer (`ChartAggregationService.computeChartData`) mirrors the same combination and
 * silently omits `series` for anything else, so a hand-crafted/persisted bad config still can't
 * render a misleading stack.
 */
export function assertSeriesConstraints(dataSource: ChartDataSource | undefined, type: ChartType): void {
  const seriesByFieldId = dataSource?.seriesByFieldId
  if (!seriesByFieldId) return
  if (type !== 'bar') {
    throw new Error('seriesByFieldId (stacked series) is only supported for bar charts')
  }
  if (!dataSource?.groupByFieldId) {
    throw new Error('seriesByFieldId requires groupByFieldId (a primary category axis)')
  }
  if (!ADDITIVE_AGGREGATIONS.has(dataSource.aggregation?.function)) {
    throw new Error('seriesByFieldId (stacked series) requires a sum or count aggregation')
  }
}
