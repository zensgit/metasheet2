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
