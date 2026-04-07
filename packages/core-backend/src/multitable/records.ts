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

export type CreatedMultitableRecord = {
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

  const fieldById = new Map(fields.map((field) => [field.id, field]))
  const patch: Record<string, unknown> = {}

  for (const [fieldId, rawValue] of Object.entries(input.data ?? {})) {
    const field = fieldById.get(fieldId)
    if (!field) {
      throw new MultitableRecordValidationError(`Unknown fieldId: ${fieldId}`)
    }
    patch[fieldId] = normalizeFieldValue(field, rawValue)
  }

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
