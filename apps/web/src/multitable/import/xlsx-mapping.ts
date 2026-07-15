import type { MetaField } from '../types'

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

type WorkbookLike = {
  SheetNames: string[]
  Sheets: Record<string, unknown>
}

type XlsxModule = {
  read(data: ArrayBuffer | Uint8Array, opts: { type: 'array' | 'buffer' }): WorkbookLike
  write(workbook: WorkbookLike, opts: { type: 'array' | 'buffer'; bookType: 'xlsx' }): ArrayBuffer | Uint8Array
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

/**
 * Parse an `.xlsx` ArrayBuffer using the provided XLSX module. Reads the
 * first sheet only (or the explicitly named sheet when `sheetName` given)
 * and folds the data into the same `headers + rows` shape consumed by the
 * existing CSV/TSV import pipeline (`buildImportedRecords`).
 *
 * Caps:
 * - `XLSX_MAX_BYTES` enforced by caller (route or file picker).
 * - `XLSX_MAX_ROWS` enforced here; surplus rows are dropped and `truncated=true`.
 */
export function parseXlsxBuffer(
  xlsx: XlsxModule,
  buffer: ArrayBuffer | Uint8Array,
  options?: { sheetName?: string },
): ParsedXlsxResult {
  const workbook = xlsx.read(buffer, { type: 'array' })
  const requestedSheet = options?.sheetName?.trim() || ''
  const sheetName = requestedSheet && workbook.SheetNames.includes(requestedSheet)
    ? requestedSheet
    : workbook.SheetNames[0]
  if (!sheetName) {
    return { headers: [], rows: [], sheetName: '', truncated: false }
  }
  const ws = workbook.Sheets[sheetName]
  if (!ws) {
    return { headers: [], rows: [], sheetName, truncated: false }
  }

  const aoa = xlsx.utils.sheet_to_json(ws, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  })
  if (aoa.length === 0) {
    return { headers: [], rows: [], sheetName, truncated: false }
  }
  const rawHeaders = aoa[0] as unknown[]
  const headers = rawHeaders.map((cell) => normalizeHeader(cell))
  while (headers.length > 0 && headers[headers.length - 1] === '') {
    headers.pop()
  }

  const dataRows: string[][] = []
  let truncated = false
  for (let i = 1; i < aoa.length; i += 1) {
    if (dataRows.length >= XLSX_MAX_ROWS) {
      truncated = true
      break
    }
    const raw = aoa[i] as unknown[]
    const row: string[] = []
    for (let c = 0; c < headers.length; c += 1) {
      row.push(normalizeRowCell(raw[c]))
    }
    if (row.some((cell) => cell.trim().length > 0)) {
      dataRows.push(row)
    }
  }

  return { headers, rows: dataRows, sheetName, truncated }
}

/**
 * Sanitize an arbitrary display string into a workbook tab name SheetJS will accept.
 *
 * G-10 follow-up (owner ruling 2026-07-15): exports name the xlsx tab after the sheet's DISPLAY
 * name, so this boundary must tolerate hostile user-authored names. SheetJS 0.20.3's
 * `check_ws_name` (called by `book_append_sheet`) THROWS on: names longer than 31 chars, the
 * chars []:*?/\, a leading or trailing apostrophe, and the reserved name 'History'
 * (case-insensitive — empirically verified against the pinned dependency). Rules applied in
 * order: forbidden chars → spaces; trim; cap at 31; strip edge apostrophes (re-trim — the strip
 * can expose new edge whitespace); reserved 'History' → 'History_' suffix (7 chars, so the
 * suffix can never overflow the cap); empty → 'Sheet1'.
 */
export function safeXlsxSheetName(name: string | undefined): string {
  const cleaned = (name ?? '')
    .replace(/[\\/\[\]:*?]/g, ' ')
    .trim()
    .slice(0, 31)
    .replace(/^'+|'+$/g, '')
    .trim()
  if (!cleaned) return 'Sheet1'
  if (/^history$/i.test(cleaned)) return `${cleaned}_`
  return cleaned
}

/**
 * Build an `.xlsx` Uint8Array (browser-safe) from a tabular dataset.
 * Headers row first, then string-coerced data rows. Caller is responsible
 * for typing/formatting via the `serialize` callback.
 *
 * The tab name is sanitized via `safeXlsxSheetName`, so this function never throws on a
 * hostile `sheetName` (defense in depth: callers may pre-sanitize, but the boundary holds).
 */
export function buildXlsxBuffer(
  xlsx: XlsxModule,
  params: {
    sheetName?: string
    headers: string[]
    rows: Array<Array<string | number | boolean | null | undefined>>
  },
): Uint8Array {
  const sheetName = safeXlsxSheetName(params.sheetName)
  const aoa: unknown[][] = [params.headers.slice()]
  for (const row of params.rows) {
    aoa.push(row.map((cell) => (cell === undefined || cell === null ? '' : cell)))
  }
  const ws = xlsx.utils.aoa_to_sheet(aoa)
  const wb = xlsx.utils.book_new()
  xlsx.utils.book_append_sheet(wb, ws, sheetName)
  const out = xlsx.write(wb, { type: 'array', bookType: 'xlsx' })
  return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer)
}

/**
 * Best-effort case-insensitive header → field mapping. Returns the inverse
 * (column-index keyed) form that `buildImportedRecords` already accepts so
 * the existing CSV mapping editor can consume the result unchanged.
 */
export function mapXlsxColumnsToFields(
  headers: string[],
  fields: Pick<MetaField, 'id' | 'name' | 'type' | 'property'>[],
  options?: { excludeReadOnly?: boolean },
): XlsxColumnMapping {
  const excludeReadOnly = options?.excludeReadOnly !== false
  const mapping: Record<number, string> = {}
  const usedFieldIds = new Set<string>()
  const unmappedHeaders: string[] = []

  const importableFields = fields.filter((field) => {
    if (['formula', 'lookup', 'rollup'].includes(field.type)) return false
    if (!excludeReadOnly) return true
    const property = (field.property ?? {}) as Record<string, unknown>
    return property.readonly !== true && property.readOnly !== true
  })
  const fieldsByLowerName = new Map<string, string>()
  for (const field of importableFields) {
    const key = field.name.trim().toLowerCase()
    if (!key) continue
    if (!fieldsByLowerName.has(key)) fieldsByLowerName.set(key, field.id)
  }

  headers.forEach((header, index) => {
    const normalized = header.trim().toLowerCase()
    if (!normalized) {
      unmappedHeaders.push(header)
      return
    }
    const fieldId = fieldsByLowerName.get(normalized)
    if (!fieldId || usedFieldIds.has(fieldId)) {
      unmappedHeaders.push(header)
      return
    }
    mapping[index] = fieldId
    usedFieldIds.add(fieldId)
  })

  const unmappedFields = importableFields
    .filter((field) => !usedFieldIds.has(field.id))
    .map((field) => field.id)

  return { mapping, unmappedHeaders, unmappedFields }
}
