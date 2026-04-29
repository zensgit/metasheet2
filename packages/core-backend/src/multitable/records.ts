import { randomUUID } from 'crypto'

import { fieldTypeRegistry } from './field-type-registry'
import { loadFieldsForSheet, loadSheetRow } from './loaders'
import { MultitableRecordNotFoundError, MultitableRecordValidationError } from './record-errors'
import {
  listRecords as listRecordsViaQueryService,
  queryRecords as queryRecordsViaQueryService,
  queryRecordsWithCursor as queryRecordsWithCursorViaQueryService,
  type CursorPaginatedResult,
  type CursorQueryInput,
  type ListMultitableRecordsInput,
  type LoadedMultitableRecord,
  type MultitableRecordsQueryFn,
  type QueryMultitableRecordsInput,
} from './query-service'

export { MultitableRecordNotFoundError, MultitableRecordValidationError } from './record-errors'
export {
  buildRecordsCacheKey,
  decodeRecordCursor,
  encodeRecordCursor,
} from './query-service'
export type {
  CursorPaginatedResult,
  CursorQueryInput,
  ListMultitableRecordsInput,
  LoadedMultitableRecord,
  MultitableRecordFilterValue,
  MultitableRecordQueryOrder,
  MultitableRecordsQueryFn,
  QueryMultitableRecordsInput,
} from './query-service'

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

function normalizeMultiSelectValue(
  value: unknown,
  fieldId: string,
  options: string[],
): string[] {
  if (value === null || value === undefined || value === '') return []
  if (!Array.isArray(value)) {
    throw new MultitableRecordValidationError(`Multi-select value must be array: ${fieldId}`)
  }

  const allowed = new Set(options)
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      throw new MultitableRecordValidationError(`Multi-select option must be string: ${fieldId}`)
    }
    const option = String(item).trim()
    if (!option) continue
    if (!allowed.has(option)) {
      throw new MultitableRecordValidationError(`Invalid multi-select option for ${fieldId}: ${option}`)
    }
    if (!seen.has(option)) {
      seen.add(option)
      out.push(option)
    }
  }
  return out
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
    case 'multiSelect':
      return normalizeMultiSelectValue(
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
    default: {
      const customDef = fieldTypeRegistry.get(field.type)
      if (customDef) {
        return customDef.validate(value, field.id)
      }
      return value
    }
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
  return listRecordsViaQueryService(input)
}

export async function queryRecords(
  input: QueryMultitableRecordsInput,
): Promise<LoadedMultitableRecord[]> {
  return queryRecordsViaQueryService(input)
}

export async function queryRecordsWithCursor(
  input: CursorQueryInput,
): Promise<CursorPaginatedResult<LoadedMultitableRecord>> {
  return queryRecordsWithCursorViaQueryService(input)
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
