/**
 * Chart type definitions for multitable dashboard V1.
 */

// S3: area / funnel / gauge are RENDER-LAYER types — the aggregation service computes them through
// the same grouped {label,value} pipeline as bar/line/pie (no per-type math; series split stays
// bar/line-only). The frontend maps area→line+areaStyle, funnel→stages, gauge→first-point/total dial.
// r12: scatter is the ONE non-grouped type — a PER-RECORD x/y projection (no groupBy / aggregation /
// seriesBy / dateField). It branches early in the producer and carries xValue/yValue (+ optional size)
// per dataPoint; `label` is its optional color category. See `ChartDataSource` x/y/color/sizeFieldId.
export type ChartType = 'bar' | 'line' | 'pie' | 'number' | 'table' | 'area' | 'funnel' | 'gauge' | 'scatter'

export type AggregationFunction = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct'

export interface ChartAggregation {
  function: AggregationFunction
  fieldId?: string // required for sum/avg/min/max, optional for count
}

export interface ChartDataSource {
  /** What to group by (X axis for bar/line, slices for pie) */
  groupByFieldId?: string

  /**
   * v2-d: split each primary-axis bucket into series. Honored for a `bar` or `line` chart with a
   * primary axis — either `groupByFieldId` or a date axis (`dateFieldId` + `dateGrouping`, v2-d-b3).
   * A STACKED bar additionally requires an additive aggregation (sum/count); a grouped bar
   * (`display.barMode='grouped'`, v2-d-b1) and a multi-series line (v2-d-b2) accept any aggregation.
   * See `assertSeriesConstraints`; inert / rejected otherwise.
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

  /**
   * r12 scatter (a discriminant — meaningful ONLY when `type === 'scatter'`). Scatter is a per-record
   * x/y projection, so it ignores `groupByFieldId` / `aggregation` / `seriesByFieldId` / `dateFieldId`.
   * `xFieldId` + `yFieldId` are both required (numeric fields). `colorFieldId` sets the per-point
   * `label` (color category); `sizeFieldId` sets the per-point `size`. `limit` caps the number of
   * points (no sort — scatter has no value to sort by).
   */
  xFieldId?: string
  yFieldId?: string
  colorFieldId?: string
  sizeFieldId?: string

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
  /**
   * v2-d-b1: bar series layout when `seriesByFieldId` is set. 'stacked' (default) sums segments
   * into one bar; 'grouped' renders them side-by-side (and, being independent, allows non-additive
   * aggregations). Inert unless `seriesByFieldId` is set on a bar chart.
   */
  barMode?: 'stacked' | 'grouped'
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
 * v2-d series (`seriesByFieldId`) constraints. No-op when unset; otherwise throws unless the chart is
 * a `bar` or `line` with a primary axis — `groupByFieldId` OR a date axis (`dateFieldId` +
 * `dateGrouping`, v2-d-b3). A STACKED bar (default `barMode`) additionally requires an additive
 * aggregation (sum/count); a grouped bar (`barMode='grouped'`) and a line accept any aggregation.
 *
 * Enforced at EVERY input boundary (preview + persisted create/update) so the UI is never the sole
 * guard; the producer (`ChartAggregationService.computeChartData`) mirrors the same combination and
 * silently omits `series` for anything else, so a hand-crafted/persisted bad config still can't
 * render a misleading stack.
 */
export function assertSeriesConstraints(
  dataSource: ChartDataSource | undefined,
  type: ChartType,
  barMode?: ChartDisplayConfig['barMode'],
): void {
  const seriesByFieldId = dataSource?.seriesByFieldId
  if (!seriesByFieldId) return
  // v2-d-b2: bar and line carry a series split (line = overlaid lines, never stacked).
  if (type !== 'bar' && type !== 'line') {
    throw new Error('seriesByFieldId is only supported for bar and line charts')
  }
  // v2-d-b3: the primary axis is groupByFieldId OR a date axis (dateFieldId + dateGrouping). One of
  // them must be present; a date axis provides its own primary (groupByFieldId not required there).
  const dateGrouped = Boolean(dataSource.dateFieldId && dataSource.dateGrouping)
  if (!dataSource?.groupByFieldId && !dateGrouped) {
    throw new Error('seriesByFieldId requires groupByFieldId or date grouping (a primary axis)')
  }
  // Additive aggregation is required ONLY for a STACKED bar — its segment heights must sum to a
  // meaningful total. Grouped (side-by-side) bars are independent, and lines never stack, so both
  // accept any aggregation. This holds for a date axis too: a stacked bar over time still needs an
  // additive aggregation. (v2-d-b1 = grouped relaxation; v2-d-b2 = line; v2-d-b3 = date axis.)
  if (type === 'bar' && barMode !== 'grouped' && !ADDITIVE_AGGREGATIONS.has(dataSource.aggregation?.function)) {
    throw new Error('stacked series require a sum or count aggregation (use barMode "grouped" for others)')
  }
}

/**
 * A scatter chart is a per-record x/y projection — it requires both axis fields (review M3: the
 * persisted POST/PATCH path must enforce this, not just the preview path + config UI, or a direct
 * API write of a scatter chart with no x/y would persist and later render an empty plot).
 */
export function assertScatterFields(dataSource: ChartDataSource | undefined, type: ChartType): void {
  if (type !== 'scatter') return
  if (!dataSource?.xFieldId || !dataSource?.yFieldId) {
    throw new Error('scatter requires xFieldId and yFieldId')
  }
}
