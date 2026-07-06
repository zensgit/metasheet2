// Selection-time column recognition for the attendance CSV importer: parse the
// chosen file's header line client-side and classify every column against the
// import vocabulary — green (recognized, will import), grey (unknown, ignored
// but still usable by rule matching), red (required column family missing) —
// so a DingTalk-export customer sees column problems at selection time instead
// of a failed preview. Pure and dependency-free; mirrors the backend's header
// constants (fixture-sync tested against plugins/plugin-attendance/index.cjs).
// See docs/development/attendance-import-column-recognition-design-lock-20260706.md.

import type { AttendanceImportMappingColumnLike } from './importTemplateColumns'

/** Mirrors backend IMPORT_HEADER_DATE_KEYS (already in normalized form). */
export const IMPORT_HEADER_DATE_KEYS = ['日期', 'date', 'workdate'] as const

/** Mirrors backend IMPORT_HEADER_CONTEXT_KEYS (already in normalized form). */
export const IMPORT_HEADER_CONTEXT_KEYS = [
  'userid',
  '用户id',
  'name',
  '姓名',
  '工号',
  'empno',
  'firstinat',
  'lastoutat',
  'status',
  'attendancegroup',
  'attendanceclass',
  'shiftname',
  '上班1打卡时间',
  '下班1打卡时间',
  '考勤结果',
  '考勤组',
  '班次',
] as const

/** Mirrors backend normalizeImportHeaderLookupKey: trim → lowercase → strip whitespace/_/-. */
export function normalizeHeaderLookupKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
}

/**
 * Quote-aware parse of the header row from the head of a CSV text: honors the
 * configured delimiter and an optional explicit header row index; strips BOM
 * and trims cells (mirroring backend normalizeCsvHeaderValue); skips leading
 * all-empty rows when no explicit index is given.
 */
export function parseCsvHeaderFromText(
  text: string,
  options?: { delimiter?: string; headerRowIndex?: number | null },
): string[] {
  if (typeof text !== 'string' || !text.trim()) return []
  // Backend iterateCsvRows splits on the delimiter's FIRST char only — mirror
  // that (review P3-1) so a two-char delimiter cannot flip green/red.
  const delimiter = options?.delimiter && options.delimiter.length > 0 ? options.delimiter[0] : ','
  const explicitIndex = Number.isInteger(options?.headerRowIndex) && (options!.headerRowIndex as number) >= 0
    ? (options!.headerRowIndex as number)
    : null

  const rows: string[][] = []
  let cells: string[] = []
  let cell = ''
  let inQuotes = false
  const pushCell = () => { cells.push(cell.replace(/\ufeff/g, '').trim()); cell = '' }
  const pushRow = () => { pushCell(); rows.push(cells); cells = [] }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { cell += '"'; i += 1 } else { inQuotes = !inQuotes }
      continue
    }
    if (!inQuotes && ch === delimiter) { pushCell(); continue }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      pushRow()
      if (explicitIndex !== null ? rows.length > explicitIndex : rows.some(row => row.some(Boolean))) break
      continue
    }
    cell += ch
  }
  if (cells.length > 0 || cell.length > 0) pushRow()

  if (explicitIndex !== null) return rows[explicitIndex] ?? []
  return rows.find(row => row.some(Boolean)) ?? []
}

export interface AttendanceImportRecognizedColumn {
  column: string
  /** true = matches an import mapping alias (imports as a record field); false = header/identity key family match */
  viaVocabulary: boolean
}

export interface AttendanceImportHeaderRecognition {
  /** columns the importer recognizes (mapping alias / date / context match) */
  recognized: AttendanceImportRecognizedColumn[]
  /** columns the importer will ignore (still visible to rule matching) */
  unknown: string[]
  missingDate: boolean
  missingContext: boolean
}

/**
 * Classify a parsed header against the import vocabulary. `mappingColumns` may
 * be empty (vocabulary fetch failed) — recognition then degrades to the
 * date/context key families only, and the required-column flags stay exact.
 */
export function recognizeImportHeader(
  header: readonly string[],
  mappingColumns: readonly AttendanceImportMappingColumnLike[] | null | undefined,
): AttendanceImportHeaderRecognition | null {
  const columns = header.map(value => String(value ?? '').replace(/\ufeff/g, '').trim()).filter(Boolean)
  if (columns.length === 0) return null

  const sourceKeys = new Set<string>()
  for (const column of Array.isArray(mappingColumns) ? mappingColumns : []) {
    const key = normalizeHeaderLookupKey(column?.sourceField)
    if (key) sourceKeys.add(key)
  }
  const dateKeys = new Set<string>(IMPORT_HEADER_DATE_KEYS)
  const contextKeys = new Set<string>(IMPORT_HEADER_CONTEXT_KEYS)

  const recognized: AttendanceImportRecognizedColumn[] = []
  const unknown: string[] = []
  let hasDate = false
  let hasContext = false
  for (const column of columns) {
    const key = normalizeHeaderLookupKey(column)
    if (dateKeys.has(key)) hasDate = true
    if (contextKeys.has(key)) hasContext = true
    if (sourceKeys.has(key)) recognized.push({ column, viaVocabulary: true })
    else if (dateKeys.has(key) || contextKeys.has(key)) recognized.push({ column, viaVocabulary: false })
    else unknown.push(column)
  }
  return { recognized, unknown, missingDate: !hasDate, missingContext: !hasContext }
}

/** Read the head of a blob as text: Blob.text with a FileReader fallback. */
export async function readBlobHeadText(blob: Blob, maxBytes = 128 * 1024): Promise<string> {
  const head = typeof blob.slice === 'function' ? blob.slice(0, maxBytes) : blob
  if (typeof head.text === 'function') {
    return await head.text()
  }
  if (typeof FileReader === 'undefined') return ''
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsText(head)
  })
}
