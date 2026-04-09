import { randomUUID } from 'crypto'

import { loadFieldsForSheet, loadSheetRow } from './loaders'

export type MultitableRecordsQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export class MultitableRecordValidationError extends Error {
  code = 'VALIDATION_ERROR'
}

export class MultitableRecordNotFoundError extends Error {
  code = 'NOT_FOUND'
}

export type CreateMultitableRecordInput = {
  query: MultitableRecordsQueryFn
  sheetId: string
  data: Record<string, unknown>
}

export type GetMultitableRecordInput = {
  query: MultitableRecordsQueryFn
  sheetId: string
  recordId: string
}

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

export type DeleteMultitableRecordInput = {
  query: MultitableRecordsQueryFn
  sheetId: string
  recordId: string
}

export type PatchMultitableRecordInput = {
  query: MultitableRecordsQueryFn
  sheetId: string
  recordId: string
  changes: Record<string, unknown>
}

export type CreatedMultitableRecord = {
  id: string
  sheetId: string
  version: number
  data: Record<string, unknown>
}

export type LoadedMultitableRecord = {
  id: string
  sheetId: string
  version: number
  data: Record<string, unknown>
}

export type DeletedMultitableRecord = {
  id: string
  sheetId: string
  version: number
}

type LoadedMultitableField = Awaited<ReturnType<typeof loadFieldsForSheet>>[number]
type LinkFieldConfig = {
  foreignSheetId: string
  limitSingleRecord: boolean
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeNumber(value: unknown, fieldId: string): number {
  if (isFiniteNumber(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new MultitableRecordValidationError(`Number value must be finite: ${fieldId}`)
}

function normalizeSelectValue(
  value: unknown,
  fieldId: string,
  options: string[],
): string {
  if (typeof value !== 'string') {
    throw new MultitableRecordValidationError(`Select value must be string: ${fieldId}`)
  }
  if (value === '') return value
  const allowed = new Set(options)
  if (!allowed.has(value)) {
    throw new MultitableRecordValidationError(`Invalid select option for ${fieldId}: ${value}`)
  }
  return value
}

function normalizeLinkIds(value: unknown): string[] {
  if (value === null || value === undefined) return []

  const raw: string[] = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') raw.push(item)
      else if (typeof item === 'number' && Number.isFinite(item)) raw.push(String(item))
    }
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    try {
      const parsed = JSON.parse(trimmed)
      raw.push(...normalizeLinkIds(parsed))
    } catch {
      if (trimmed.includes(',')) raw.push(...trimmed.split(','))
      else raw.push(trimmed)
    }
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    raw.push(String(value))
  }

  const seen = new Set<string>()
  return raw
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
}

function readLinkFieldConfig(field: LoadedMultitableField): LinkFieldConfig | null {
  if (field.type !== 'link') return null

  const property = field.property
  const foreignSheetId =
    typeof property?.foreignSheetId === 'string' && property.foreignSheetId.trim()
      ? property.foreignSheetId.trim()
      : typeof property?.foreignDatasheetId === 'string' && property.foreignDatasheetId.trim()
        ? property.foreignDatasheetId.trim()
        : typeof property?.datasheetId === 'string' && property.datasheetId.trim()
          ? property.datasheetId.trim()
          : ''

  if (!foreignSheetId) return null
  return {
    foreignSheetId,
    limitSingleRecord: property?.limitSingleRecord === true,
  }
}

function normalizeFieldValue(
  field: LoadedMultitableField,
  value: unknown,
): unknown {
  if (value === null) {
    return null
  }

  switch (field.type) {
    case 'select':
      return normalizeSelectValue(
        value,
        field.id,
        (field.options ?? []).map((option) => option.value),
      )
    case 'number':
      if (value == null || value === '') return null
      return normalizeNumber(value, field.id)
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new MultitableRecordValidationError(`Boolean value must be boolean: ${field.id}`)
      }
      return value
    case 'string':
    case 'date':
      if (typeof value !== 'string') {
        throw new MultitableRecordValidationError(`String value must be string: ${field.id}`)
      }
      return value
    case 'formula':
      if (typeof value !== 'string') {
        throw new MultitableRecordValidationError(`Formula value must be string: ${field.id}`)
      }
      if (value !== '' && !value.startsWith('=')) {
        throw new MultitableRecordValidationError(`Formula must start with "=": ${field.id}`)
      }
      return value
    case 'lookup':
    case 'rollup':
    case 'attachment':
      throw new MultitableRecordValidationError(
        `Field type is not supported by multitable.records.createRecord yet: ${field.id}`,
      )
    default:
      return value
  }
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
      console.warn('[multitable.records] Failed to parse meta_records.data JSON', err)
      return {}
    }
  }
  return {}
}

async function validateLinkIds(
  query: MultitableRecordsQueryFn,
  fieldId: string,
  config: LinkFieldConfig,
  ids: string[],
): Promise<void> {
  if (config.limitSingleRecord && ids.length > 1) {
    throw new MultitableRecordValidationError(`Only one linked record is allowed: ${fieldId}`)
  }
  const tooLong = ids.find((id) => id.length > 50)
  if (tooLong) {
    throw new MultitableRecordValidationError(`Link id too long: ${tooLong}`)
  }
  if (ids.length === 0) return

  const exists = await query(
    'SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
    [config.foreignSheetId, ids],
  )
  const found = new Set((exists.rows as any[]).map((row: any) => String(row.id)))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length > 0) {
    throw new MultitableRecordValidationError(
      `Linked record(s) not found in sheet ${config.foreignSheetId}: ${missing.join(', ')}`,
    )
  }
}

async function buildNormalizedPatch(
  query: MultitableRecordsQueryFn,
  fields: LoadedMultitableField[],
  data: Record<string, unknown>,
): Promise<{
  patch: Record<string, unknown>
  linkUpdates: Map<string, string[]>
}> {
  const fieldById = new Map(fields.map((field) => [field.id, field]))
  const patch: Record<string, unknown> = {}
  const linkUpdates = new Map<string, string[]>()

  for (const [fieldId, rawValue] of Object.entries(data ?? {})) {
    const field = fieldById.get(fieldId)
    if (!field) {
      throw new MultitableRecordValidationError(`Unknown fieldId: ${fieldId}`)
    }
    if (field.type === 'link') {
      const config = readLinkFieldConfig(field)
      if (!config) {
        throw new MultitableRecordValidationError(
          `Link field is missing foreign sheet configuration: ${fieldId}`,
        )
      }
      const ids = normalizeLinkIds(rawValue)
      await validateLinkIds(query, fieldId, config, ids)
      patch[fieldId] = ids
      linkUpdates.set(fieldId, ids)
      continue
    }
    patch[fieldId] = normalizeFieldValue(field, rawValue)
  }

  return { patch, linkUpdates }
}

async function replaceRecordLinks(
  query: MultitableRecordsQueryFn,
  recordId: string,
  linkUpdates: Map<string, string[]>,
): Promise<void> {
  for (const [fieldId, ids] of linkUpdates.entries()) {
    const currentLinks = await query(
      'SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2',
      [fieldId, recordId],
    )
    const existingIds = (currentLinks.rows as any[]).map((row: any) => String(row.foreign_record_id))
    const existing = new Set(existingIds)
    const next = new Set(ids)
    const toDelete = existingIds.filter((id) => !next.has(id))
    const toInsert = ids.filter((id) => !existing.has(id))

    if (toDelete.length > 0) {
      await query(
        'DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = ANY($3::text[])',
        [fieldId, recordId, toDelete],
      )
    }

    for (const foreignId of toInsert) {
      await query(
        `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [`lnk_${randomUUID()}`, fieldId, recordId, foreignId],
      )
    }
  }
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
  fields: LoadedMultitableField[]
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

export async function getRecord(
  input: GetMultitableRecordInput,
): Promise<LoadedMultitableRecord> {
  const recordRes = await input.query(
    'SELECT id, sheet_id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
    [input.recordId, input.sheetId],
  )
  const row = (recordRes.rows as any[])[0]
  if (!row) {
    throw new MultitableRecordNotFoundError(`Record not found: ${input.recordId}`)
  }
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
  return (recordRes.rows as any[]).map((row) => ({
    id: String(row.id),
    sheetId: String(row.sheet_id),
    version: Number(row.version ?? 1),
    data: normalizeRecordData(row.data),
  }))
}

export async function patchRecord(
  input: PatchMultitableRecordInput,
): Promise<LoadedMultitableRecord> {
  const query = input.query
  const { fields } = await loadSheetAndFields(query, input.sheetId)

  const existing = await getRecord({
    query,
    sheetId: input.sheetId,
    recordId: input.recordId,
  })
  const { patch, linkUpdates } = await buildNormalizedPatch(query, fields, input.changes)
  const nextData = {
    ...existing.data,
    ...patch,
  }

  const updated = await query(
    `UPDATE meta_records
     SET data = $1::jsonb, version = version + 1, updated_at = now()
     WHERE id = $2 AND sheet_id = $3
     RETURNING version`,
    [JSON.stringify(nextData), input.recordId, input.sheetId],
  )

  if (linkUpdates.size > 0) {
    await replaceRecordLinks(query, input.recordId, linkUpdates)
  }

  const version = Number((updated.rows as any[])[0]?.version ?? existing.version + 1)
  return {
    id: existing.id,
    sheetId: existing.sheetId,
    version: Number.isFinite(version) ? version : existing.version + 1,
    data: nextData,
  }
}

export async function createRecord(
  input: CreateMultitableRecordInput,
): Promise<CreatedMultitableRecord> {
  const query = input.query
  const { fields } = await loadSheetAndFields(query, input.sheetId)

  const { patch, linkUpdates } = await buildNormalizedPatch(query, fields, input.data)

  const recordId = `rec_${randomUUID()}`
  const inserted = await query(
    `INSERT INTO meta_records (id, sheet_id, data, version)
     VALUES ($1, $2, $3::jsonb, 1)
     RETURNING version`,
    [recordId, input.sheetId, JSON.stringify(patch)],
  )

  if (linkUpdates.size > 0) {
    await replaceRecordLinks(query, recordId, linkUpdates)
  }

  const version = Number((inserted.rows as any[])[0]?.version ?? 1)
  return {
    id: recordId,
    sheetId: input.sheetId,
    version: Number.isFinite(version) ? version : 1,
    data: patch,
  }
}

export async function deleteRecord(
  input: DeleteMultitableRecordInput,
): Promise<DeletedMultitableRecord> {
  const query = input.query
  await loadSheetAndFields(query, input.sheetId)

  await query('DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1', [input.recordId])

  const deleted = await query(
    `DELETE FROM meta_records
     WHERE id = $1 AND sheet_id = $2
     RETURNING version`,
    [input.recordId, input.sheetId],
  )
  const row = (deleted.rows as any[])[0]
  if (!row) {
    throw new MultitableRecordNotFoundError(`Record not found: ${input.recordId}`)
  }
  return {
    id: input.recordId,
    sheetId: input.sheetId,
    version: Number(row.version ?? 1),
  }
}
