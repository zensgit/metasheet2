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
  /** Workbook properties; `WBProps.date1904` = serials count from 1904-01-01 (Mac Excel legacy). */
  Workbook?: { WBProps?: { date1904?: boolean } }
}

/** The subset of SheetJS's SSF (number-format) library the date-cell normaliser needs. */
type XlsxSsfLike = {
  is_date(fmt: string): boolean
  /** `date1904` selects the 1904 epoch; without it a 1904-system workbook's serials read 4 years and a day early. */
  parse_date_code(v: number, opts?: { date1904?: boolean }): { D: number; y: number; m: number; d: number; H: number; M: number; S: number } | null
}

type XlsxModule = {
  read(data: ArrayBuffer | Uint8Array, opts: { type: 'array' | 'buffer'; cellNF?: boolean }): WorkbookLike
  SSF?: XlsxSsfLike
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

type XlsxCellLike = { t?: string; v?: unknown; z?: unknown; w?: unknown }

// A number format shows a TIME when it carries hour/second tokens outside quoted literals, brackets and
// escapes (`m/d/yy h:mm`, `h:mm:ss`); `m/d/yy` / `yyyy-mm-dd` are date-only (their `m` is month).
function numberFormatHasTimeTokens(fmt: string): boolean {
  const bare = fmt.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')
  return /[hHsS]/.test(bare)
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 客户反馈 2026-09-24 #4c (PR #6083 review, must-fix): Excel NATIVE date cells — the web twin of core-backend
 * `xlsx-service.ts` `normalizeXlsxDateCells` (same rules, same output text).
 *
 * A date-typed Excel cell is a serial NUMBER with a date number format (numFmt 22 `m/d/yy h:mm`, 14
 * `m/d/yy`, …); `sheet_to_json({ raw: false })` renders it as `"9/24/26 9:00"`, which the importer's grammar
 * rejects. Rewrite such cells IN PLACE into the grammar's text from SheetJS's SSF date arithmetic on the
 * serial — the Excel wall clock as written, no timezone: time format → `YYYY-MM-DD HH:mm[:ss]`; date-only
 * format → `YYYY-MM-DD` (`calendarDayFromText` then keeps that day for a `date` field); time-only serial →
 * `HH:mm[:ss]`. `options.date1904` must be the workbook's `WBProps.date1904` (Mac Excel's 1904 epoch: the
 * same serial is a different day, and SheetJS's own text hides it). Text cells are never touched. Known nit:
 * elapsed-time formats (`[h]:mm`) pass `SSF.is_date` and become a meaningless day text. Needs
 * `read(…, { cellNF: true })`; without SSF the sheet is left as is.
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
  // cellNF keeps each cell's number format so Excel-native date cells can be recognised below.
  const workbook = xlsx.read(buffer, { type: 'array', cellNF: true })
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
