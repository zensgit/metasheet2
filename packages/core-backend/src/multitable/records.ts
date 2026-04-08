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

function normalizeFieldValue(
  field: { id: string; type: string; options?: Array<{ value: string }> },
  value: unknown,
): unknown {
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
    case 'link':
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

function buildNormalizedPatch(
  fields: Array<{ id: string; type: string; options?: Array<{ value: string }> }>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const fieldById = new Map(fields.map((field) => [field.id, field]))
  const patch: Record<string, unknown> = {}

  for (const [fieldId, rawValue] of Object.entries(data ?? {})) {
    const field = fieldById.get(fieldId)
    if (!field) {
      throw new MultitableRecordValidationError(`Unknown fieldId: ${fieldId}`)
    }
    patch[fieldId] = normalizeFieldValue(field, rawValue)
  }

  return patch
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

export async function patchRecord(
  input: PatchMultitableRecordInput,
): Promise<LoadedMultitableRecord> {
  const query = input.query
  const sheet = await loadSheetRow(query, input.sheetId)
  if (!sheet) {
    throw new MultitableRecordNotFoundError(`Sheet not found: ${input.sheetId}`)
  }

  const fields = await loadFieldsForSheet({ query }, input.sheetId)
  if (fields.length === 0) {
    throw new MultitableRecordNotFoundError(`Sheet not found: ${input.sheetId}`)
  }

  const existing = await getRecord({
    query,
    sheetId: input.sheetId,
    recordId: input.recordId,
  })
  const patch = buildNormalizedPatch(fields, input.changes)
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
  const sheet = await loadSheetRow(query, input.sheetId)
  if (!sheet) {
    throw new MultitableRecordNotFoundError(`Sheet not found: ${input.sheetId}`)
  }

  const fields = await loadFieldsForSheet({ query }, input.sheetId)
  if (fields.length === 0) {
    throw new MultitableRecordNotFoundError(`Sheet not found: ${input.sheetId}`)
  }

  const patch = buildNormalizedPatch(fields, input.data)

  const recordId = `rec_${randomUUID()}`
  const inserted = await query(
    `INSERT INTO meta_records (id, sheet_id, data, version)
     VALUES ($1, $2, $3::jsonb, 1)
     RETURNING version`,
    [recordId, input.sheetId, JSON.stringify(patch)],
  )

  const version = Number((inserted.rows as any[])[0]?.version ?? 1)
  return {
    id: recordId,
    sheetId: input.sheetId,
    version: Number.isFinite(version) ? version : 1,
    data: patch,
  }
}
