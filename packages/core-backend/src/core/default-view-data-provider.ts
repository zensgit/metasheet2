/**
 * Default View Data Provider
 *
 * Provides default data retrieval from table_rows table.
 * This is the fallback provider when no view-specific provider is registered.
 */

import type {
  ViewDataProvider,
  ViewDataContext,
  ViewDataQueryOptions,
  ViewDataResult,
  FilterCondition,
  DataPool
} from '../types/view-data'

/**
 * Default view data provider that reads from table_rows
 */
export class DefaultViewDataProvider implements ViewDataProvider {
  readonly viewType = 'default'

  /**
   * Get data with pagination and filtering
   */
  async getData(
    context: ViewDataContext,
    options: ViewDataQueryOptions,
    pool: DataPool
  ): Promise<ViewDataResult> {
    const { tableId } = context
    const { pagination, sorting, filters, search, searchFields, visibleFields } = options

    // Build the base query
    let sql = 'SELECT * FROM table_rows WHERE table_id = $1 AND deleted_at IS NULL'
    const params: unknown[] = [tableId]
    let paramIndex = 2

    // Apply filters
    if (filters && filters.length > 0) {
      const mergedFilters = this.applyViewFilters(filters, context)
      for (const filter of mergedFilters) {
        const { clause, value, nextIndex } = this.buildFilterClause(filter, paramIndex)
        sql += ` AND ${clause}`
        if (value !== undefined) {
          params.push(value)
          paramIndex = nextIndex
        }
      }
    }

    // Apply search across specified fields
    if (search && searchFields && searchFields.length > 0) {
      const searchConditions = searchFields.map((field, i) => {
        const idx = paramIndex + i
        return `data->>'${this.sanitizeField(field)}' ILIKE $${idx}`
      })
      sql += ` AND (${searchConditions.join(' OR ')})`
      searchFields.forEach(() => {
        params.push(`%${search}%`)
        paramIndex++
      })
    }

    // Get total count first
    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total')
    const countResult = await pool.query<{ total: string }>(countSql, params)
    const total = parseInt(countResult.rows[0]?.total || '0', 10)

    // Apply sorting
    if (sorting && sorting.length > 0) {
      const sortClauses = sorting.map(s => {
        const field = this.sanitizeField(s.field)
        const direction = s.direction === 'desc' ? 'DESC' : 'ASC'
        // Sort by JSONB field
        return `data->>'${field}' ${direction}`
      })
      sql += ` ORDER BY ${sortClauses.join(', ')}`
    } else {
      sql += ' ORDER BY row_order ASC, created_at ASC'
    }

    // Apply pagination
    const offset = pagination.offset ?? (pagination.page - 1) * pagination.pageSize
    sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`
    params.push(pagination.pageSize, offset)

    // Execute query
    const result = await pool.query(sql, params)

    // Transform rows
    const data = result.rows.map(row => {
      const rowData = this.extractRowData(row, visibleFields)
      return this.transformRow(rowData, context)
    })

    // Calculate pagination metadata
    const totalPages = Math.ceil(total / pagination.pageSize)

    return {
      data,
      meta: {
        total,
        page: pagination.page,
        pageSize: pagination.pageSize,
        totalPages,
        hasNextPage: pagination.page < totalPages,
        hasPrevPage: pagination.page > 1
      }
    }
  }

  /**
   * Get grouped data (default implementation groups by field)
   */
  async getGroupedData(
    context: ViewDataContext,
    groupField: string,
    options: ViewDataQueryOptions,
    pool: DataPool
  ): Promise<ViewDataResult> {
    // Get all data first (respecting filters but without pagination)
    const allDataOptions: ViewDataQueryOptions = {
      ...options,
      pagination: { page: 1, pageSize: 10000 } // Large limit for grouping
    }
    const result = await this.getData(context, allDataOptions, pool)

    // Group by field
    const groups: Record<string, Record<string, unknown>[]> = {}
    for (const row of result.data) {
      const groupValue = String(row[groupField] ?? 'uncategorized')
      if (!groups[groupValue]) {
        groups[groupValue] = []
      }
      groups[groupValue].push(row)
    }

    // Apply pagination to each group if needed
    const paginatedData: Record<string, unknown>[] = []
    const { page, pageSize } = options.pagination
    const offset = (page - 1) * pageSize

    let totalInPage = 0
    for (const [_groupKey, groupRows] of Object.entries(groups)) {
      if (totalInPage >= offset && paginatedData.length < pageSize) {
        paginatedData.push(...groupRows.slice(0, pageSize - paginatedData.length))
      }
      totalInPage += groupRows.length
    }

    return {
      data: paginatedData,
      meta: result.meta,
      groups
    }
  }

  /**
   * Search data with text query
   */
  async searchData(
    context: ViewDataContext,
    query: string,
    options: ViewDataQueryOptions,
    pool: DataPool
  ): Promise<ViewDataResult> {
    // Default to searching all fields if not specified
    const searchFields = options.searchFields || ['title', 'name', 'description']
    return this.getData(
      context,
      { ...options, search: query, searchFields },
      pool
    )
  }

  /**
   * Transform row data to output format
   */
  transformRow(
    row: Record<string, unknown>,
    context: ViewDataContext
  ): Record<string, unknown> {
    // Default: return row as-is
    // Plugins can override for view-specific transformations
    return {
      ...row,
      _viewType: context.viewType,
      _viewId: context.viewId
    }
  }

  /**
   * Apply view-specific filters
   */
  applyViewFilters(
    baseFilters: FilterCondition[],
    context: ViewDataContext
  ): FilterCondition[] {
    // Merge with view's saved filters
    const viewFilters = context.filters || []
    return [...viewFilters, ...baseFilters]
  }

  /**
   * Get aggregations (counts, sums, etc.)
   */
  async getAggregations(
    context: ViewDataContext,
    aggregations: Array<{
      field: string
      operation: 'count' | 'sum' | 'avg' | 'min' | 'max'
      alias?: string
    }>,
    pool: DataPool
  ): Promise<Record<string, unknown>> {
    const { tableId } = context

    const aggClauses = aggregations.map(agg => {
      const field = this.sanitizeField(agg.field)
      const alias = agg.alias || `${agg.operation}_${field}`

      switch (agg.operation) {
        case 'count':
          return `COUNT(CASE WHEN data->>'${field}' IS NOT NULL THEN 1 END) as "${alias}"`
        case 'sum':
          return `SUM((data->>'${field}')::numeric) as "${alias}"`
        case 'avg':
          return `AVG((data->>'${field}')::numeric) as "${alias}"`
        case 'min':
          return `MIN(data->>'${field}') as "${alias}"`
        case 'max':
          return `MAX(data->>'${field}') as "${alias}"`
        default:
          return `COUNT(*) as "${alias}"`
      }
    })

    const sql = `
      SELECT ${aggClauses.join(', ')}
      FROM table_rows
      WHERE table_id = $1 AND deleted_at IS NULL
    `

    const result = await pool.query(sql, [tableId])
    return result.rows[0] || {}
  }

  /**
   * Extract row data from database row, optionally filtering visible fields
   */
  private extractRowData(
    row: Record<string, unknown>,
    visibleFields?: string[]
  ): Record<string, unknown> {
    const data = (row.data as Record<string, unknown>) || {}

    // Always include system fields
    const baseData = {
      id: row.id,
      row_order: row.row_order,
      created_at: row.created_at,
      updated_at: row.updated_at
    }

    if (!visibleFields || visibleFields.length === 0) {
      return { ...baseData, ...data }
    }

    // Filter to visible fields only
    const filteredData: Record<string, unknown> = {}
    for (const field of visibleFields) {
      if (field in data) {
        filteredData[field] = data[field]
      }
    }

    return { ...baseData, ...filteredData }
  }

  /**
   * Build SQL clause for a filter condition
   */
  private buildFilterClause(
    filter: FilterCondition,
    paramIndex: number
  ): { clause: string; value: unknown; nextIndex: number } {
    const field = this.sanitizeField(filter.field)
    const jsonPath = `data->>'${field}'`

    switch (filter.operator) {
      case 'eq':
        return { clause: `${jsonPath} = $${paramIndex}`, value: filter.value, nextIndex: paramIndex + 1 }
      case 'ne':
        return { clause: `${jsonPath} != $${paramIndex}`, value: filter.value, nextIndex: paramIndex + 1 }
      case 'gt':
        return { clause: `(${jsonPath})::numeric > $${paramIndex}`, value: filter.value, nextIndex: paramIndex + 1 }
      case 'gte':
        return { clause: `(${jsonPath})::numeric >= $${paramIndex}`, value: filter.value, nextIndex: paramIndex + 1 }
      case 'lt':
        return { clause: `(${jsonPath})::numeric < $${paramIndex}`, value: filter.value, nextIndex: paramIndex + 1 }
      case 'lte':
        return { clause: `(${jsonPath})::numeric <= $${paramIndex}`, value: filter.value, nextIndex: paramIndex + 1 }
      case 'like':
        return { clause: `${jsonPath} LIKE $${paramIndex}`, value: filter.value, nextIndex: paramIndex + 1 }
      case 'ilike':
        return { clause: `${jsonPath} ILIKE $${paramIndex}`, value: filter.value, nextIndex: paramIndex + 1 }
      case 'in': {
        const values = Array.isArray(filter.value) ? filter.value : [filter.value]
        const placeholders = values.map((_, i) => `$${paramIndex + i}`).join(', ')
        return { clause: `${jsonPath} IN (${placeholders})`, value: values[0], nextIndex: paramIndex + values.length }
      }
      case 'nin': {
        const ninValues = Array.isArray(filter.value) ? filter.value : [filter.value]
        const ninPlaceholders = ninValues.map((_, i) => `$${paramIndex + i}`).join(', ')
        return { clause: `${jsonPath} NOT IN (${ninPlaceholders})`, value: ninValues[0], nextIndex: paramIndex + ninValues.length }
      }
      case 'isNull':
        return { clause: `${jsonPath} IS NULL`, value: undefined, nextIndex: paramIndex }
      case 'isNotNull':
        return { clause: `${jsonPath} IS NOT NULL`, value: undefined, nextIndex: paramIndex }
      case 'between': {
        const [min, _max] = Array.isArray(filter.value) ? filter.value : [filter.value, filter.value]
        return { clause: `(${jsonPath})::numeric BETWEEN $${paramIndex} AND $${paramIndex + 1}`, value: min, nextIndex: paramIndex + 2 }
      }
      default:
        return { clause: `${jsonPath} = $${paramIndex}`, value: filter.value, nextIndex: paramIndex + 1 }
    }
  }

  /**
   * Sanitize field name to prevent SQL injection
   */
  private sanitizeField(field: string): string {
    return field.replace(/[^a-zA-Z0-9_]/g, '')
  }
}

/**
 * Singleton instance of default provider
 */
let defaultProviderInstance: DefaultViewDataProvider | null = null

export function getDefaultViewDataProvider(): DefaultViewDataProvider {
  if (!defaultProviderInstance) {
    defaultProviderInstance = new DefaultViewDataProvider()
  }
  return defaultProviderInstance
}
