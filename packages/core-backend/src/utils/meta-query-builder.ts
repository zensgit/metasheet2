/**
 * Meta Query Builder - SQL Pushdown Utilities
 *
 * Provides SQL WHERE clause and ORDER BY generation for view-level
 * filter and sort operations, enabling database-level query optimization.
 *
 * @module utils/meta-query-builder
 */

// ============================================================================
// Types
// ============================================================================

export type MetaFieldType = 'string' | 'number' | 'boolean' | 'formula' | 'select' | 'link'

export interface MetaFilterCondition {
  fieldId: string
  operator: string
  value?: unknown
}

export interface MetaFilterInfo {
  conjunction: 'and' | 'or'
  conditions: MetaFilterCondition[]
}

export interface MetaSortRule {
  fieldId: string
  desc: boolean
}

export interface MetaSortInfo {
  rules: MetaSortRule[]
}

export interface QueryBuilderContext {
  /** Field ID to type mapping */
  fieldTypes: Map<string, MetaFieldType>
  /** Parameter index counter (for $1, $2, etc.) */
  paramIndex: number
}

export interface QueryFragment {
  sql: string
  params: unknown[]
  paramIndex: number
}

// ============================================================================
// Filter Operators
// ============================================================================

const FILTER_OPERATORS: Record<string, { sql: (jsonPath: string, paramRef: string) => string; needsValue: boolean }> = {
  // Equality
  is: { sql: (j, p) => `(${j})::text = ${p}`, needsValue: true },
  equal: { sql: (j, p) => `(${j})::text = ${p}`, needsValue: true },
  isnot: { sql: (j, p) => `(${j})::text <> ${p}`, needsValue: true },
  notequal: { sql: (j, p) => `(${j})::text <> ${p}`, needsValue: true },

  // Empty checks
  isempty: { sql: (j) => `(${j} IS NULL OR (${j})::text = '' OR (${j})::text = 'null')`, needsValue: false },
  isnotempty: { sql: (j) => `(${j} IS NOT NULL AND (${j})::text <> '' AND (${j})::text <> 'null')`, needsValue: false },

  // String contains
  contains: { sql: (j, p) => `(${j})::text ILIKE '%' || ${p} || '%'`, needsValue: true },
  doesnotcontain: { sql: (j, p) => `(${j})::text NOT ILIKE '%' || ${p} || '%'`, needsValue: true },

  // Numeric comparisons
  greater: { sql: (j, p) => `(${j})::numeric > (${p})::numeric`, needsValue: true },
  isgreater: { sql: (j, p) => `(${j})::numeric > (${p})::numeric`, needsValue: true },
  greaterequal: { sql: (j, p) => `(${j})::numeric >= (${p})::numeric`, needsValue: true },
  isgreaterequal: { sql: (j, p) => `(${j})::numeric >= (${p})::numeric`, needsValue: true },
  less: { sql: (j, p) => `(${j})::numeric < (${p})::numeric`, needsValue: true },
  isless: { sql: (j, p) => `(${j})::numeric < (${p})::numeric`, needsValue: true },
  lessequal: { sql: (j, p) => `(${j})::numeric <= (${p})::numeric`, needsValue: true },
  islessequal: { sql: (j, p) => `(${j})::numeric <= (${p})::numeric`, needsValue: true },
}

export function isFilterOperatorSupported(operator: string): boolean {
  const key = operator.trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(FILTER_OPERATORS, key)
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert value to string for SQL comparison
 */
function toSqlString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * Normalize filter scalar (unwrap single-element arrays)
 */
function normalizeFilterScalar(value: unknown): unknown {
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Build JSONB path accessor for a field
 */
function buildJsonPath(fieldId: string): string {
  // Use ->> for text extraction from JSONB
  return `data->>'${fieldId}'`
}

function buildSafeNumericExpression(fieldId: string): string {
  const raw = buildJsonPath(fieldId)
  return `CASE WHEN ${raw} ~ '^-?\\\\d+(\\\\.\\\\d+)?$' THEN (${raw})::numeric END`
}

function buildSafeBooleanExpression(fieldId: string): string {
  const raw = `lower(${buildJsonPath(fieldId)})`
  return `CASE WHEN ${raw} IN ('true','t','yes','y','1') THEN true WHEN ${raw} IN ('false','f','no','n','0') THEN false ELSE NULL END`
}

/**
 * Build JSONB path accessor that preserves type for sorting
 */
function buildJsonPathTyped(fieldId: string, fieldType: MetaFieldType): string {
  switch (fieldType) {
    case 'number':
      return buildSafeNumericExpression(fieldId)
    case 'boolean':
      return buildSafeBooleanExpression(fieldId)
    default:
      return `data->>'${fieldId}'`
  }
}

// ============================================================================
// Filter Builder
// ============================================================================

/**
 * Build SQL WHERE clause from filter info
 *
 * @param filterInfo - Filter configuration from view
 * @param context - Query builder context
 * @returns Query fragment with WHERE clause (without "WHERE" keyword)
 */
export function buildFilterClause(
  filterInfo: MetaFilterInfo | null | undefined,
  context: QueryBuilderContext
): QueryFragment | null {
  if (!filterInfo || !filterInfo.conditions || filterInfo.conditions.length === 0) {
    return null
  }

  const validConditions = filterInfo.conditions.filter((c) => {
    if (!c.fieldId || typeof c.fieldId !== 'string') return false
    if (!c.operator || typeof c.operator !== 'string') return false
    return context.fieldTypes.has(c.fieldId)
  })

  if (validConditions.length === 0) {
    return null
  }

  const fragments: string[] = []
  const params: unknown[] = []
  let paramIndex = context.paramIndex

  for (const condition of validConditions) {
    const opNorm = condition.operator.trim().toLowerCase()
    const opConfig = FILTER_OPERATORS[opNorm]

    if (!opConfig) {
      // Unknown operator - skip (fallback to in-memory)
      continue
    }

    const fieldType = context.fieldTypes.get(condition.fieldId)
    const jsonPath = fieldType === 'number' ? buildSafeNumericExpression(condition.fieldId) : buildJsonPath(condition.fieldId)

    if (!opConfig.needsValue) {
      // No parameter needed (isEmpty, isNotEmpty)
      fragments.push(opConfig.sql(jsonPath, ''))
    } else {
      const value = normalizeFilterScalar(condition.value)
      const sqlValue = toSqlString(value)
      paramIndex += 1
      fragments.push(opConfig.sql(jsonPath, `$${paramIndex}`))
      params.push(sqlValue)
    }
  }

  if (fragments.length === 0) {
    return null
  }

  const conjunction = filterInfo.conjunction === 'or' ? ' OR ' : ' AND '
  const sql = fragments.length === 1 ? fragments[0] : `(${fragments.join(conjunction)})`

  return {
    sql,
    params,
    paramIndex,
  }
}

// ============================================================================
// Sort Builder
// ============================================================================

/**
 * Build SQL ORDER BY clause from sort info
 *
 * @param sortInfo - Sort configuration from view
 * @param context - Query builder context
 * @returns SQL ORDER BY clause (without "ORDER BY" keyword)
 */
export function buildSortClause(
  sortInfo: MetaSortInfo | null | undefined,
  context: QueryBuilderContext
): string | null {
  if (!sortInfo || !sortInfo.rules || sortInfo.rules.length === 0) {
    return null
  }

  const validRules = sortInfo.rules.filter((r) => {
    if (!r.fieldId || typeof r.fieldId !== 'string') return false
    return context.fieldTypes.has(r.fieldId)
  })

  if (validRules.length === 0) {
    return null
  }

  const orderParts: string[] = []

  for (const rule of validRules) {
    const fieldType = context.fieldTypes.get(rule.fieldId) ?? 'string'
    const jsonPath = buildJsonPathTyped(rule.fieldId, fieldType)
    const direction = rule.desc ? 'DESC' : 'ASC'

    // NULLS LAST ensures empty/null values sort at the end
    orderParts.push(`${jsonPath} ${direction} NULLS LAST`)
  }

  // Add stable sort by created_at and id
  orderParts.push('created_at ASC', 'id ASC')

  return orderParts.join(', ')
}

// ============================================================================
// Full Query Builder
// ============================================================================

export interface MetaQueryOptions {
  sheetId: string
  filterInfo?: MetaFilterInfo | null
  sortInfo?: MetaSortInfo | null
  fieldTypes: Map<string, MetaFieldType>
  limit?: number
  offset?: number
}

export interface MetaQuery {
  /** SQL query string */
  sql: string
  /** Query parameters */
  params: unknown[]
  /** Count query for pagination */
  countSql: string
  /** Count query parameters */
  countParams: unknown[]
  /** Whether SQL pushdown was used (false = fallback to in-memory) */
  usedPushdown: boolean
}

/**
 * Build optimized query for meta records with optional SQL pushdown
 *
 * @param options - Query options
 * @returns Query object with SQL and parameters
 */
export function buildMetaRecordQuery(options: MetaQueryOptions): MetaQuery {
  const { sheetId, filterInfo, sortInfo, fieldTypes, limit, offset = 0 } = options

  const context: QueryBuilderContext = {
    fieldTypes,
    paramIndex: 1, // $1 is sheetId
  }

  // Try to build filter clause
  const filterFragment = buildFilterClause(filterInfo ?? null, context)

  // Try to build sort clause
  const sortClause = buildSortClause(sortInfo ?? null, context)

  // Base query parts
  const selectColumns = 'id, version, data, created_at'
  const baseTable = 'meta_records'
  const baseWhere = 'sheet_id = $1'

  // Build WHERE clause
  let whereClause = baseWhere
  const params: unknown[] = [sheetId]

  if (filterFragment) {
    whereClause = `${baseWhere} AND ${filterFragment.sql}`
    params.push(...filterFragment.params)
    context.paramIndex = filterFragment.paramIndex
  }

  // Build ORDER BY clause
  const orderBy = sortClause || 'created_at ASC, id ASC'

  // Build pagination
  let pagination = ''
  if (limit) {
    context.paramIndex += 1
    const limitParam = context.paramIndex
    context.paramIndex += 1
    const offsetParam = context.paramIndex
    pagination = ` LIMIT $${limitParam} OFFSET $${offsetParam}`
    params.push(limit, offset)
  }

  const sql = `SELECT ${selectColumns} FROM ${baseTable} WHERE ${whereClause} ORDER BY ${orderBy}${pagination}`

  // Build count query (without ORDER BY and LIMIT)
  const countParams = filterFragment ? [sheetId, ...filterFragment.params] : [sheetId]
  const countSql = `SELECT COUNT(*)::int AS total FROM ${baseTable} WHERE ${whereClause}`

  return {
    sql,
    params,
    countSql,
    countParams,
    usedPushdown: !!filterFragment || !!sortClause,
  }
}

// ============================================================================
// Parse Helpers
// ============================================================================

/**
 * Parse sort rules from raw sortInfo object
 */
export function parseSortRules(sortInfo: unknown): MetaSortInfo | null {
  if (!sortInfo || typeof sortInfo !== 'object') return null

  const rawRules = (sortInfo as { rules?: unknown }).rules
  if (!Array.isArray(rawRules)) return null

  const rules: MetaSortRule[] = []
  for (const raw of rawRules) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    const fieldId = obj.fieldId
    if (typeof fieldId !== 'string' || fieldId.trim().length === 0) continue
    rules.push({ fieldId: fieldId.trim(), desc: obj.desc === true })
  }

  return rules.length > 0 ? { rules } : null
}

/**
 * Parse filter info from raw filterInfo object
 */
export function parseFilterInfo(filterInfo: unknown): MetaFilterInfo | null {
  if (!filterInfo || typeof filterInfo !== 'object') return null

  const obj = filterInfo as { conjunction?: unknown; conditions?: unknown }
  if (!Array.isArray(obj.conditions)) return null

  const conditions: MetaFilterCondition[] = []
  for (const raw of obj.conditions) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const fieldId = item.fieldId
    const operator = item.operator
    if (typeof fieldId !== 'string' || fieldId.trim().length === 0) continue
    if (typeof operator !== 'string' || operator.trim().length === 0) continue
    conditions.push({
      fieldId: fieldId.trim(),
      operator: operator.trim(),
      ...(Object.prototype.hasOwnProperty.call(item, 'value') ? { value: item.value } : {}),
    })
  }

  if (conditions.length === 0) return null

  const conjunctionRaw = typeof obj.conjunction === 'string' ? obj.conjunction.trim().toLowerCase() : 'and'
  const conjunction: 'and' | 'or' = conjunctionRaw === 'or' ? 'or' : 'and'

  return { conjunction, conditions }
}
