/**
 * View Data Provider Interface
 *
 * This interface defines the contract for view-specific data providers.
 * Each view type plugin can implement this interface to handle their
 * specific data retrieval, filtering, and transformation logic.
 *
 * The core views router delegates data operations to registered providers,
 * maintaining architectural purity and separation of concerns.
 */

import type { QueryResult, QueryResultRow } from 'pg'

/**
 * Database pool interface - compatible with both pg.Pool and ConnectionPool wrapper
 */
export interface DataPool {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>
}

/**
 * Pagination options for data queries
 */
export interface PaginationOptions {
  page: number
  pageSize: number
  offset?: number
}

/**
 * Sorting configuration
 */
export interface SortOptions {
  field: string
  direction: 'asc' | 'desc'
}

/**
 * Filter condition
 */
export interface FilterCondition {
  field: string
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'nin' | 'between' | 'isNull' | 'isNotNull'
  value: unknown
}

/**
 * View data query options
 */
export interface ViewDataQueryOptions {
  pagination: PaginationOptions
  sorting?: SortOptions[]
  filters?: FilterCondition[]
  search?: string
  searchFields?: string[]
  visibleFields?: string[]
  groupBy?: string
  includeMetadata?: boolean
}

/**
 * View data result with metadata
 */
export interface ViewDataResult<T = Record<string, unknown>> {
  data: T[]
  meta: {
    total: number
    page: number
    pageSize: number
    totalPages: number
    hasNextPage: boolean
    hasPrevPage: boolean
  }
  groups?: Record<string, T[]>
}

/**
 * View context with configuration and table info
 */
export interface ViewDataContext {
  viewId: string
  viewType: string
  tableId: string
  config: Record<string, unknown>
  filters?: FilterCondition[]
  sorting?: SortOptions[]
  visibleFields?: string[]
}

/**
 * View data provider interface
 * Plugins implement this to handle their specific data retrieval
 */
export interface ViewDataProvider {
  /**
   * The view type this provider handles (e.g., 'gallery', 'calendar', 'kanban')
   */
  readonly viewType: string

  /**
   * Get data for a view with pagination and filtering
   * @param context View context with configuration
   * @param options Query options
   * @param pool Database connection pool
   * @returns Data result with pagination metadata
   */
  getData(
    context: ViewDataContext,
    options: ViewDataQueryOptions,
    pool: DataPool
  ): Promise<ViewDataResult>

  /**
   * Get data grouped by a field (useful for kanban, calendar, etc.)
   * @param context View context
   * @param groupField Field to group by
   * @param options Query options
   * @param pool Database pool
   * @returns Grouped data result
   */
  getGroupedData?(
    context: ViewDataContext,
    groupField: string,
    options: ViewDataQueryOptions,
    pool: DataPool
  ): Promise<ViewDataResult>

  /**
   * Search data with text query
   * @param context View context
   * @param query Search query
   * @param options Query options
   * @param pool Database pool
   */
  searchData?(
    context: ViewDataContext,
    query: string,
    options: ViewDataQueryOptions,
    pool: DataPool
  ): Promise<ViewDataResult>

  /**
   * Transform raw database row to view-specific format
   * @param row Raw database row
   * @param context View context
   */
  transformRow?(
    row: Record<string, unknown>,
    context: ViewDataContext
  ): Record<string, unknown>

  /**
   * Apply view-specific filters
   * @param baseFilters Filters from view configuration
   * @param context View context
   */
  applyViewFilters?(
    baseFilters: FilterCondition[],
    context: ViewDataContext
  ): FilterCondition[]

  /**
   * Get aggregation data (counts, sums, etc.)
   * @param context View context
   * @param aggregations Aggregation definitions
   * @param pool Database pool
   */
  getAggregations?(
    context: ViewDataContext,
    aggregations: Array<{
      field: string
      operation: 'count' | 'sum' | 'avg' | 'min' | 'max'
      alias?: string
    }>,
    pool: DataPool
  ): Promise<Record<string, unknown>>
}

/**
 * Registry for view data providers
 */
export interface ViewDataProviderRegistry {
  /**
   * Register a view data provider
   * @param provider The provider to register
   */
  register(provider: ViewDataProvider): void

  /**
   * Unregister a view data provider
   * @param viewType The view type to unregister
   */
  unregister(viewType: string): void

  /**
   * Get a provider for a specific view type
   * @param viewType The view type
   * @returns The provider or undefined if not found
   */
  get(viewType: string): ViewDataProvider | undefined

  /**
   * Check if a provider is registered for a view type
   * @param viewType The view type
   */
  has(viewType: string): boolean

  /**
   * Get all registered view types
   */
  getRegisteredTypes(): string[]
}

/**
 * Factory function type for creating view data providers
 */
export type ViewDataProviderFactory = () => ViewDataProvider
