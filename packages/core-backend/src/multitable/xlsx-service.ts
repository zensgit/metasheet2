import type { MultitableField } from './field-codecs'
import { normalizeJson } from './field-codecs'
import { isFieldAlwaysReadOnly, isFieldPermissionHidden } from './permission-derivation'

export const XLSX_MAX_ROWS = 50_000
export const XLSX_MAX_BYTES = 100 * 1024 * 1024

export type ParsedXlsxResult = {
  headers: string[]
  rows: string[][]
  sheetName: string
  truncated: boolean
}

export type XlsxColumnMapping = {
  mapping: Record<number, string>
  unmappedHeaders: string[]
  unmappedFields: string[]
}

export type XlsxImportRecordBuildResult = {
  records: Array<Record<string, unknown>>
  rowIndexes: number[]
}

export type WorkbookLike = {
  SheetNames: string[]
  Sheets: Record<string, unknown>
}

export type XlsxModule = {
  read(data: ArrayBuffer | Uint8Array, opts: { type: 'array' | 'buffer' }): WorkbookLike
  write(workbook: WorkbookLike, opts: { type: 'array' | 'buffer'; bookType: 'xlsx' }): ArrayBuffer | Uint8Array | Buffer
  utils: {
    sheet_to_json(ws: unknown, opts: {
      header: 1
      raw?: boolean
      defval?: unknown
      blankrows?: boolean
    }): unknown[][]
    aoa_to_sheet(rows: unknown[][]): unknown
    book_new(): WorkbookLike
    book_append_sheet(wb: WorkbookLike, ws: unknown, name: string): void
  }
}

function normalizeHeader(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function normalizeRowCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString()
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  return String(value)
}

function sanitizeSheetName(name: string): string {
  const sanitized = name.replace(/[\[\]:*?/\\]/g, ' ').trim()
  return (sanitized || 'Sheet1').slice(0, 31)
}

export function parseXlsxBuffer(
  xlsx: XlsxModule,
  buffer: Buffer | ArrayBuffer | Uint8Array,
  options?: { sheetName?: string },
): ParsedXlsxResult {
  const workbook = xlsx.read(buffer, { type: 'buffer' })
  const requestedSheet = options?.sheetName?.trim() || ''
  const sheetName = requestedSheet && workbook.SheetNames.includes(requestedSheet)
    ? requestedSheet
    : workbook.SheetNames[0]
  if (!sheetName) return { headers: [], rows: [], sheetName: '', truncated: false }

  const ws = workbook.Sheets[sheetName]
  if (!ws) return { headers: [], rows: [], sheetName, truncated: false }

  const aoa = xlsx.utils.sheet_to_json(ws, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  })
  if (aoa.length === 0) return { headers: [], rows: [], sheetName, truncated: false }

  const headers = (aoa[0] as unknown[]).map((cell) => normalizeHeader(cell))
  while (headers.length > 0 && headers[headers.length - 1] === '') headers.pop()

  const rows: string[][] = []
  let truncated = false
  for (let i = 1; i < aoa.length; i += 1) {
    if (rows.length >= XLSX_MAX_ROWS) {
      truncated = true
      break
    }
    const raw = aoa[i] as unknown[]
    const row = headers.map((_header, index) => normalizeRowCell(raw[index]))
    if (row.some((cell) => cell.trim().length > 0)) rows.push(row)
  }

  return { headers, rows, sheetName, truncated }
}

export function buildXlsxBuffer(
  xlsx: XlsxModule,
  params: {
    sheetName?: string
    headers: string[]
    rows: Array<Array<string | number | boolean | null | undefined>>
  },
): Buffer {
  const aoa: unknown[][] = [params.headers.slice()]
  for (const row of params.rows) {
    aoa.push(row.map((cell) => (cell === undefined || cell === null ? '' : cell)))
  }

  const ws = xlsx.utils.aoa_to_sheet(aoa)
  const wb = xlsx.utils.book_new()
  xlsx.utils.book_append_sheet(wb, ws, sanitizeSheetName(params.sheetName ?? 'Sheet1'))
  const out = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
  return Buffer.isBuffer(out) ? out : Buffer.from(out)
}

export function isXlsxImportableField(field: Pick<MultitableField, 'type' | 'property'>): boolean {
  if (field.type === 'formula' || field.type === 'lookup' || field.type === 'rollup') return false
  if (isFieldAlwaysReadOnly(field) || isFieldPermissionHidden(field)) return false
  const property = normalizeJson(field.property)
  return property.readonly !== true && property.readOnly !== true
}

export function mapXlsxColumnsToFields(
  headers: string[],
  fields: Pick<MultitableField, 'id' | 'name' | 'type' | 'property'>[],
): XlsxColumnMapping {
  const mapping: Record<number, string> = {}
  const usedFieldIds = new Set<string>()
  const unmappedHeaders: string[] = []

  const fieldsByLowerName = new Map<string, string>()
  for (const field of fields.filter(isXlsxImportableField)) {
    const key = field.name.trim().toLowerCase()
    if (key && !fieldsByLowerName.has(key)) fieldsByLowerName.set(key, field.id)
  }

  headers.forEach((header, index) => {
    const fieldId = fieldsByLowerName.get(header.trim().toLowerCase())
    if (!fieldId || usedFieldIds.has(fieldId)) {
      unmappedHeaders.push(header)
      return
    }
    mapping[index] = fieldId
    usedFieldIds.add(fieldId)
  })

  const unmappedFields = fields
    .filter(isXlsxImportableField)
    .filter((field) => !usedFieldIds.has(field.id))
    .map((field) => field.id)

  return { mapping, unmappedHeaders, unmappedFields }
}

export function normalizeXlsxColumnMapping(
  rawMapping: unknown,
  headers: string[],
  fields: Pick<MultitableField, 'id' | 'name' | 'type' | 'property'>[],
): XlsxColumnMapping {
  if (!rawMapping || typeof rawMapping !== 'object' || Array.isArray(rawMapping)) {
    return mapXlsxColumnsToFields(headers, fields)
  }

  const importableFieldIds = new Set(fields.filter(isXlsxImportableField).map((field) => field.id))
  const usedFieldIds = new Set<string>()
  const mapping: Record<number, string> = {}
  const unmappedHeaders: string[] = []

  for (let index = 0; index < headers.length; index += 1) {
    const value = (rawMapping as Record<string, unknown>)[String(index)]
    const fieldId = typeof value === 'string' ? value.trim() : ''
    if (!fieldId) {
      unmappedHeaders.push(headers[index] ?? '')
      continue
    }
    if (!importableFieldIds.has(fieldId)) {
      throw new Error(`XLSX column ${index} maps to a non-importable field: ${fieldId}`)
    }
    if (usedFieldIds.has(fieldId)) {
      throw new Error(`XLSX mapping assigns field more than once: ${fieldId}`)
    }
    mapping[index] = fieldId
    usedFieldIds.add(fieldId)
  }

  const unmappedFields = fields
    .filter(isXlsxImportableField)
    .filter((field) => !usedFieldIds.has(field.id))
    .map((field) => field.id)

  return { mapping, unmappedHeaders, unmappedFields }
}

export function buildXlsxImportRecords(
  parsed: Pick<ParsedXlsxResult, 'rows'>,
  mapping: Record<number, string>,
): XlsxImportRecordBuildResult {
  const records: Array<Record<string, unknown>> = []
  const rowIndexes: number[] = []

  parsed.rows.forEach((row, rowIndex) => {
    const data: Record<string, unknown> = {}
    for (const [columnIndexRaw, fieldId] of Object.entries(mapping)) {
      const columnIndex = Number.parseInt(columnIndexRaw, 10)
      if (!Number.isFinite(columnIndex)) continue
      data[fieldId] = row[columnIndex] ?? ''
    }
    if (Object.keys(data).length > 0) {
      records.push(data)
      rowIndexes.push(rowIndex)
    }
  })

  return { records, rowIndexes }
}

export function serializeXlsxCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item === null || item === undefined) return ''
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return String(item)
        return JSON.stringify(item)
      })
      .filter((item) => item.length > 0)
      .join(', ')
  }
  return JSON.stringify(value)
}
