export type AttendanceImportPayload = Record<string, any>
export type AttendanceImportPayloadColumn = Record<string, unknown>

const IMPORT_COLUMN_ID_KEYS = [
  'id',
  'column_id',
  'columnId',
  'key',
  'name',
  'header',
  'sourceField',
  'source',
  'field',
  'label',
]

const IMPORT_COLUMN_NAME_KEYS = [
  'name',
  'header',
  'sourceField',
  'source',
  'field',
  'key',
  'label',
]

function firstNonEmptyField(
  source: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    const value = source[key]
    if (String(value ?? '').trim()) return value
  }
  return undefined
}

export function normalizeImportPayloadColumn(column: unknown): AttendanceImportPayloadColumn | null {
  if (typeof column === 'string' || typeof column === 'number') {
    const text = String(column).trim()
    if (!text) return null
    return {
      id: column,
      name: text,
    }
  }

  if (!column || typeof column !== 'object' || Array.isArray(column)) return null
  const source = column as Record<string, unknown>
  const id = firstNonEmptyField(source, IMPORT_COLUMN_ID_KEYS)
  if (id === undefined) return null

  const normalized: AttendanceImportPayloadColumn = {
    ...source,
    id,
  }
  if (typeof normalized.name !== 'string' || !normalized.name.trim()) {
    const name = firstNonEmptyField(source, IMPORT_COLUMN_NAME_KEYS)
    if (name !== undefined) normalized.name = String(name).trim()
  }
  return normalized
}

export function normalizeImportPayloadColumns(payload: AttendanceImportPayload) {
  if (!Array.isArray(payload.columns)) return
  payload.columns = payload.columns
    .map(normalizeImportPayloadColumn)
    .filter((column): column is AttendanceImportPayloadColumn => Boolean(column))
}
