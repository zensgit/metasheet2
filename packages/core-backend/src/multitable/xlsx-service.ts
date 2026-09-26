import type { MultitableField } from './field-codecs'
import { normalizeJson } from './field-codecs'
import { isFieldAlwaysReadOnly, isFieldPermissionHidden } from './permission-derivation'

export const XLSX_MAX_ROWS = 50_000
export const XLSX_MAX_BYTES = 100 * 1024 * 1024

export type ParsedXlsxResult = {
  headers: string[]
  rows: string[][]
  sheetName: string
  sheetCount: number
  hasFormula: boolean
  hasUnheadedData: boolean
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
  /** Workbook properties; `WBProps.date1904` = the workbook counts serials from 1904-01-01 (Mac Excel legacy). */
  Workbook?: { WBProps?: { date1904?: boolean } }
}

/** The subset of SheetJS's SSF (spreadsheet number-format) library the date-cell normaliser needs. */
export type XlsxSsfLike = {
  /** True when a number format renders its value as a date / time (built-in ids 14–22, 45–47 and custom `yyyy-mm-dd`…). */
  is_date(fmt: string): boolean
  /**
   * The civil parts an Excel serial denotes — pure arithmetic, no timezone (`null` for an out-of-range serial).
   * `date1904` selects the 1904 epoch; without it a 1904-system workbook's serials read 4 years and a day early.
   */
  parse_date_code(v: number, opts?: { date1904?: boolean }): { D: number; y: number; m: number; d: number; H: number; M: number; S: number } | null
}

export type XlsxModule = {
  read(data: ArrayBuffer | Uint8Array, opts: {
    type: 'array' | 'buffer'
    sheetRows?: number
    cellFormula?: boolean
    /** Keep each cell's number-format string on `cell.z` (off by default) — needed to recognise date cells. */
    cellNF?: boolean
  }): WorkbookLike
  SSF?: XlsxSsfLike
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

type XlsxCellLike = { t?: string; v?: unknown; z?: unknown; w?: unknown }

// A number format shows a TIME when it carries hour/second tokens outside quoted literals, brackets and
// escapes (`m/d/yy h:mm`, `h:mm:ss`, `mm:ss`); `m/d/yy` / `yyyy-mm-dd` are date-only (their `m` is month).
function numberFormatHasTimeTokens(fmt: string): boolean {
  const bare = fmt.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')
  return /[hHsS]/.test(bare)
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 客户反馈 2026-09-24 #4c (PR #6083 review, must-fix): Excel NATIVE date cells.
 *
 * A cell Excel typed as a date/time is stored as a serial NUMBER with a date number format (built-in
 * numFmt 22 `m/d/yy h:mm`, 14 `m/d/yy`, …). `sheet_to_json({ raw: false })` renders it with that format —
 * `"9/24/26 9:00"` — a US-locale spelling neither the server grammar (`date-time-wall-clock.ts`) nor the
 * web importer reads (the pre-#6083 `new Date(text)` happened to parse it — in the process zone). This
 * rewrites every such cell IN PLACE into the grammar's own text, using SheetJS's SSF date arithmetic on the
 * serial (no timezone involved — the Excel wall clock as written):
 *   - a format with time tokens → `YYYY-MM-DD HH:mm[:ss]` (a dateTime field then reads it in the field /
 *     business zone);
 *   - a date-only format → `YYYY-MM-DD` (the calendar day as written). NOTE: the server import path does
 *     NOT coerce `date` fields — that text is stored verbatim, as any other string would be (server-side
 *     date coercion is a listed follow-up; the web importer's `calendarDayFromText` does normalise it);
 *   - a time-only value (serial < 1) → `HH:mm[:ss]` (readable text; a dateTime field rightly refuses it).
 * `options.date1904` must be the workbook's `WBProps.date1904` (Mac Excel's 1904 epoch): the same serial is a
 * different day in the two systems, and SheetJS's own formatted text hides the difference. Cells SheetJS
 * already typed as Date (`t: 'd'`) take the same route from their UTC parts (SheetJS puts the Excel wall
 * clock into the UTC fields). Text cells are never touched — a person who typed `2026-09-24 09:00` as text
 * arrives unchanged. Known nit: elapsed-time formats (`[h]:mm`, `[mm]:ss`) are durations, not instants, but
 * `SSF.is_date` accepts them, so such a cell becomes a (meaningless) day text. Requires
 * `read(…, { cellNF: true })` so `cell.z` is present; without SSF on the module the sheet is left as is.
 */
export function normalizeXlsxDateCells(
  xlsx: Pick<XlsxModule, 'SSF'>,
  ws: unknown,
  options?: { date1904?: boolean },
): number {
  const ssf = xlsx.SSF
  if (!ssf || !ws || typeof ws !== 'object') return 0
  const dateOpts = { date1904: options?.date1904 === true }
  let rewritten = 0
  for (const [address, raw] of Object.entries(ws as Record<string, unknown>)) {
    if (address.startsWith('!') || !raw || typeof raw !== 'object') continue
    const cell = raw as XlsxCellLike
    let parts: { D: number; y: number; m: number; d: number; H: number; M: number; S: number } | null = null
    let dateOnly = false
    if (cell.t === 'n' && typeof cell.v === 'number' && Number.isFinite(cell.v) && typeof cell.z === 'string' && ssf.is_date(cell.z)) {
      parts = ssf.parse_date_code(cell.v, dateOpts)
      dateOnly = !numberFormatHasTimeTokens(cell.z)
    } else if (cell.t === 'd' && cell.v instanceof Date && !Number.isNaN(cell.v.getTime())) {
      const v = cell.v
      parts = { D: 1, y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate(), H: v.getUTCHours(), M: v.getUTCMinutes(), S: v.getUTCSeconds() }
      dateOnly = typeof cell.z === 'string' ? !numberFormatHasTimeTokens(cell.z) : parts.H === 0 && parts.M === 0 && parts.S === 0
    }
    if (!parts) continue
    const time = `${pad2(parts.H)}:${pad2(parts.M)}${parts.S ? `:${pad2(parts.S)}` : ''}`
    const day = `${String(parts.y).padStart(4, '0')}-${pad2(parts.m)}-${pad2(parts.d)}`
    const text = parts.D === 0 ? time : dateOnly ? day : `${day} ${time}`
    cell.t = 's'
    cell.v = text
    cell.w = text
    delete cell.z
    rewritten += 1
  }
  return rewritten
}

function sanitizeSheetName(name: string): string {
  const sanitized = name.replace(/[[\]:*?/\\]/g, ' ').trim()
  return (sanitized || 'Sheet1').slice(0, 31)
}

function worksheetHasFormula(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  for (const [address, cell] of Object.entries(value)) {
    if (address.startsWith('!') || !cell || typeof cell !== 'object') continue
    const formula = (cell as Record<string, unknown>).f
    if (typeof formula === 'string' && formula.trim() !== '') return true
  }
  return false
}

function worksheetExceedsRowLimit(value: unknown, maxRows: number): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const sheet = value as Record<string, unknown>
  const rawRef = typeof sheet['!fullref'] === 'string'
    ? sheet['!fullref']
    : sheet['!ref']
  if (typeof rawRef !== 'string') return false
  const end = (rawRef.split(':')[1] ?? rawRef).replaceAll('$', '')
  const match = /(\d+)$/.exec(end)
  if (!match) return false
  const lastPhysicalRow = Number(match[1])
  return Number.isSafeInteger(lastPhysicalRow) && lastPhysicalRow > maxRows + 1
}

function worksheetColumnCount(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  const sheet = value as Record<string, unknown>
  const rawRef = typeof sheet['!fullref'] === 'string'
    ? sheet['!fullref']
    : sheet['!ref']
  if (rawRef === undefined) return 0
  if (typeof rawRef !== 'string') return null
  const end = (rawRef.split(':')[1] ?? rawRef).replaceAll('$', '')
  const match = /([A-Z]+)\d+$/i.exec(end)
  if (!match) return null
  let count = 0
  for (const letter of match[1].toUpperCase()) {
    count = count * 26 + letter.charCodeAt(0) - 64
    if (!Number.isSafeInteger(count)) return null
  }
  return count
}

export function parseXlsxBuffer(
  xlsx: XlsxModule,
  buffer: Buffer | ArrayBuffer | Uint8Array,
  options?: { sheetName?: string; maxRows?: number; maxColumns?: number },
): ParsedXlsxResult {
  const maxRows = options?.maxRows ?? XLSX_MAX_ROWS
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > XLSX_MAX_ROWS) {
    throw new Error('invalid xlsx row limit')
  }
  const maxColumns = options?.maxColumns
  if (maxColumns !== undefined && (!Number.isSafeInteger(maxColumns) || maxColumns < 1)) {
    throw new Error('invalid xlsx column limit')
  }
  const workbook = xlsx.read(buffer, {
    type: 'buffer',
    ...(options?.maxRows === undefined ? {} : { sheetRows: maxRows + 2 }),
    cellFormula: true,
    // Keep number formats so Excel-native date cells can be recognised (normalizeXlsxDateCells).
    cellNF: true,
  })
  const sheetCount = workbook.SheetNames.length
  const requestedSheet = options?.sheetName?.trim() || ''
  const sheetName = requestedSheet && workbook.SheetNames.includes(requestedSheet)
    ? requestedSheet
    : workbook.SheetNames[0]
  if (!sheetName) {
    return {
      headers: [],
      rows: [],
      sheetName: '',
      sheetCount,
      hasFormula: false,
      hasUnheadedData: false,
      truncated: false,
    }
  }

  const ws = workbook.Sheets[sheetName]
  if (!ws) {
    return {
      headers: [],
      rows: [],
      sheetName,
      sheetCount,
      hasFormula: false,
      hasUnheadedData: false,
      truncated: false,
    }
  }
  const hasFormula = worksheetHasFormula(ws)
  const exceedsPhysicalLimit = options?.maxRows === undefined
    ? false
    : worksheetExceedsRowLimit(ws, maxRows)
  const columnCount = worksheetColumnCount(ws)
  if (maxColumns !== undefined && (columnCount === null || columnCount > maxColumns)) {
    throw new Error('xlsx column limit exceeded')
  }

  // Excel-native date cells → the importer's own `YYYY-MM-DD[ HH:mm]` text BEFORE the formatted read below,
  // in the workbook's own date system (1900 default, 1904 for Mac-legacy workbooks).
  normalizeXlsxDateCells(xlsx, ws, { date1904: workbook.Workbook?.WBProps?.date1904 === true })
  const aoa = xlsx.utils.sheet_to_json(ws, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  })
  if (aoa.length === 0) {
    return {
      headers: [],
      rows: [],
      sheetName,
      sheetCount,
      hasFormula,
      hasUnheadedData: false,
      truncated: exceedsPhysicalLimit,
    }
  }

  const headers = (aoa[0] as unknown[]).map((cell) => normalizeHeader(cell))
  while (headers.length > 0 && headers[headers.length - 1] === '') headers.pop()

  const rows: string[][] = []
  let truncated = exceedsPhysicalLimit
  let hasUnheadedData = false
  for (let i = 1; i < aoa.length; i += 1) {
    if (rows.length >= maxRows) {
      truncated = true
      break
    }
    const raw = aoa[i] as unknown[]
    if (raw.slice(headers.length).some((cell) => normalizeRowCell(cell).trim() !== '')) {
      hasUnheadedData = true
    }
    const row = headers.map((_header, index) => normalizeRowCell(raw[index]))
    if (row.some((cell) => cell.trim().length > 0)) rows.push(row)
  }

  return {
    headers,
    rows,
    sheetName,
    sheetCount,
    hasFormula,
    hasUnheadedData,
    truncated,
  }
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
