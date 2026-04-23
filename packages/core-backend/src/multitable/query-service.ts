import { createHash } from 'crypto'

import { loadFieldsForSheet, loadSheetRow } from './loaders'
import { MultitableRecordNotFoundError, MultitableRecordValidationError } from './record-errors'

export type MultitableRecordsQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type MultitableRecordFilterValue = string | number | boolean | null

export type MultitableRecordQueryOrder = {
  fieldId?: string
  direction?: 'asc' | 'desc'
}

export type ListMultitableRecordsInput = {
  query: MultitableRecordsQueryFn
  sheetId: string
  limit?: number
  offset?: number
}

export type QueryMultitableRecordsInput = {
  query: MultitableRecordsQueryFn
  sheetId: string
  filters?: Record<string, MultitableRecordFilterValue>
  search?: string
  orderBy?: MultitableRecordQueryOrder
  limit?: number
  offset?: number
}

export type LoadedMultitableRecord = {
  id: string
  sheetId: string
  version: number
  data: Record<string, unknown>
}

export type CursorPaginatedResult<T> = {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
}

export type CursorQueryInput = {
  query: MultitableRecordsQueryFn
  sheetId: string
  cursor?: string
  limit?: number
  sort?: MultitableRecordQueryOrder
  filter?: Record<string, MultitableRecordFilterValue>
}

export function encodeRecordCursor(id: string, sortValue: string): string {
  return Buffer.from(JSON.stringify({ id, sv: sortValue })).toString('base64url')
}

export function decodeRecordCursor(cursor: string): { id: string; sortValue: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof parsed.id !== 'string' || typeof parsed.sv !== 'string') {
      throw new MultitableRecordValidationError('Invalid cursor format')
    }
    return { id: parsed.id, sortValue: parsed.sv }
  } catch (err) {
    if (err instanceof MultitableRecordValidationError) throw err
    throw new MultitableRecordValidationError('Invalid cursor format')
  }
}

/**
 * Build a deterministic cache key hash from query parameters.
 */
export function buildRecordsCacheKey(
  sheetId: string,
  params: { filter?: Record<string, MultitableRecordFilterValue>; sort?: MultitableRecordQueryOrder; cursor?: string },
): string {
  const payload = JSON.stringify({
    f: params.filter ?? {},
    s: params.sort ?? {},
    c: params.cursor ?? '',
  })
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 16)
  return `mt:records:${sheetId}:${hash}`
}

function normalizeRecordData(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch (err) {
      console.warn('[multitable.query-service] Failed to parse meta_records.data JSON', err)
      return {}
    }
  }
  return {}
}

function normalizePagingValue(value: unknown, field: string): number | undefined {
  if (value == null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new MultitableRecordValidationError(`${field} must be a non-negative integer`)
  }
  return parsed
}

function normalizeQueryFilters(
  fields: Array<{ id: string; type: string; options?: Array<{ value: string }> }>,
  filters: Record<string, MultitableRecordFilterValue> | undefined,
): Array<{ fieldId: string; value: MultitableRecordFilterValue }> {
  const fieldIds = new Set(fields.map((field) => field.id))
  return Object.entries(filters ?? {}).map(([fieldId, value]) => {
    if (!fieldIds.has(fieldId)) {
      throw new MultitableRecordValidationError(`Unknown fieldId: ${fieldId}`)
    }
    if (value == null) {
      return { fieldId, value: null }
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return { fieldId, value }
    }
    throw new MultitableRecordValidationError(`Unsupported filter value for ${fieldId}`)
  })
}

function normalizeQueryOrder(
  fields: Array<{ id: string; type: string; options?: Array<{ value: string }> }>,
  orderBy: MultitableRecordQueryOrder | undefined,
): { fieldId: string | null; direction: 'asc' | 'desc' } {
  const direction = orderBy?.direction === 'desc' ? 'desc' : 'asc'
  if (!orderBy?.fieldId) {
    return { fieldId: null, direction }
  }
  const exists = fields.some((field) => field.id === orderBy.fieldId)
  if (!exists) {
    throw new MultitableRecordValidationError(`Unknown fieldId: ${orderBy.fieldId}`)
  }
  return { fieldId: orderBy.fieldId, direction }
}

function normalizeQuerySearch(search: unknown): string | null {
  if (typeof search !== 'string') return null
  const trimmed = search.trim()
  return trimmed ? trimmed : null
}

async function loadSheetAndFields(
  query: MultitableRecordsQueryFn,
  sheetId: string,
): Promise<{
  sheet: Awaited<ReturnType<typeof loadSheetRow>>
  fields: Awaited<ReturnType<typeof loadFieldsForSheet>>
}> {
  const sheet = await loadSheetRow(query, sheetId)
  if (!sheet) {
    throw new MultitableRecordNotFoundError(`Sheet not found: ${sheetId}`)
  }
  const fields = await loadFieldsForSheet({ query }, sheetId)
  if (fields.length === 0) {
    throw new MultitableRecordNotFoundError(`Sheet not found: ${sheetId}`)
  }
  return { sheet, fields }
}

function mapRecordRow(row: any): LoadedMultitableRecord {
  return {
    id: String(row.id),
    sheetId: String(row.sheet_id),
    version: Number(row.version ?? 1),
    data: normalizeRecordData(row.data),
  }
}

export async function listRecords(
  input: ListMultitableRecordsInput,
): Promise<LoadedMultitableRecord[]> {
  return queryRecords({
    query: input.query,
    sheetId: input.sheetId,
    limit: input.limit,
    offset: input.offset,
  })
}

export async function queryRecords(
  input: QueryMultitableRecordsInput,
): Promise<LoadedMultitableRecord[]> {
  const query = input.query
  const { fields } = await loadSheetAndFields(query, input.sheetId)
  const filters = normalizeQueryFilters(fields, input.filters)
  const search = normalizeQuerySearch(input.search)
  const orderBy = normalizeQueryOrder(fields, input.orderBy)
  const limit = normalizePagingValue(input.limit, 'limit')
  const offset = normalizePagingValue(input.offset, 'offset')

  const params: unknown[] = [input.sheetId]
  const where: string[] = ['sheet_id = $1']

  for (const filter of filters) {
    if (filter.value === null) {
      params.push(filter.fieldId)
      where.push(`data -> $${params.length} IS NULL`)
      continue
    }
    params.push(filter.fieldId, String(filter.value))
    where.push(`data ->> $${params.length - 1} = $${params.length}`)
  }

  if (search) {
    params.push(`%${search}%`)
    where.push(`data::text ILIKE $${params.length}`)
  }

  let orderSql = 'ORDER BY id ASC'
  if (orderBy.fieldId) {
    params.push(orderBy.fieldId)
    const fieldParamIndex = params.length
    orderSql = `ORDER BY data ->> $${fieldParamIndex} ${orderBy.direction.toUpperCase()} NULLS LAST, id ASC`
  }

  if (limit !== undefined) {
    params.push(limit)
  }
  const limitParamIndex = limit !== undefined ? params.length : null
  if (offset !== undefined) {
    params.push(offset)
  }
  const offsetParamIndex = offset !== undefined ? params.length : null

  const sqlParts = [
    'SELECT id, sheet_id, version, data FROM meta_records',
    `WHERE ${where.join(' AND ')}`,
    orderSql,
  ]
  if (limitParamIndex !== null) {
    sqlParts.push(`LIMIT $${limitParamIndex}`)
  }
  if (offsetParamIndex !== null) {
    sqlParts.push(`OFFSET $${offsetParamIndex}`)
  }

  const recordRes = await query(sqlParts.join(' '), params)
  return (recordRes.rows as any[]).map(mapRecordRow)
}

/**
 * Cursor-based pagination query.
 *
 * Uses keyset pagination: `WHERE (sort_column, id) > ($cursorSort, $cursorId)`.
 * Fetches `limit + 1` rows to detect `hasMore` without a separate COUNT query.
 */
export async function queryRecordsWithCursor(
  input: CursorQueryInput,
): Promise<CursorPaginatedResult<LoadedMultitableRecord>> {
  const query = input.query
  const { fields } = await loadSheetAndFields(query, input.sheetId)
  const filters = normalizeQueryFilters(fields, input.filter)
  const orderBy = normalizeQueryOrder(fields, input.sort)
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 5000)

  const params: unknown[] = [input.sheetId]
  const where: string[] = ['sheet_id = $1']

  for (const filter of filters) {
    if (filter.value === null) {
      params.push(filter.fieldId)
      where.push(`data -> $${params.length} IS NULL`)
      continue
    }
    params.push(filter.fieldId, String(filter.value))
    where.push(`data ->> $${params.length - 1} = $${params.length}`)
  }

  const direction = orderBy.direction.toUpperCase()
  let sortExpr = 'id'
  if (orderBy.fieldId) {
    params.push(orderBy.fieldId)
    sortExpr = `data ->> $${params.length}`
  }

  if (input.cursor) {
    const decoded = decodeRecordCursor(input.cursor)
    const op = direction === 'DESC' ? '<' : '>'
    params.push(decoded.sortValue, decoded.id)
    if (orderBy.fieldId) {
      where.push(
        `(${sortExpr}, id) ${op} ($${params.length - 1}, $${params.length})`,
      )
    } else {
      where.push(`id ${op} $${params.length}`)
    }
  }

  params.push(limit + 1)
  const fetchLimitIndex = params.length

  const orderSql = orderBy.fieldId
    ? `ORDER BY ${sortExpr} ${direction} NULLS LAST, id ASC`
    : `ORDER BY id ${direction}`

  const sql = [
    'SELECT id, sheet_id, version, data FROM meta_records',
    `WHERE ${where.join(' AND ')}`,
    orderSql,
    `LIMIT $${fetchLimitIndex}`,
  ].join(' ')

  const recordRes = await query(sql, params)
  const rows = (recordRes.rows as any[]).map(mapRecordRow)

  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows

  let nextCursor: string | null = null
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1]
    const sortValue = orderBy.fieldId
      ? String((last.data as Record<string, unknown>)[orderBy.fieldId] ?? '')
      : last.id
    nextCursor = encodeRecordCursor(last.id, sortValue)
  }

  return { items, nextCursor, hasMore }
}
