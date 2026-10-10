/**
 * Task feature — the task line's own CSV export of a list: format parameter, file name, cell
 * formatting and the whole body. PURE, no I/O.
 *
 * Design: docs/development/task-e-m5-pure-functions-design-20261007.md §2.8
 *
 * Columns come from `task-projection.ts`'s `taskProjectionColumns` (one catalog for the projection
 * sheet and the export). Every cell — the header row included — goes through the shared
 * `services/csv-cell.ts` helpers: `sanitizeCsvCell` (lead-character neutralization + RFC 4180
 * quoting), except a number the field codec can produce in a number column, which goes through the
 * shared `quoteRfc4180` only. This module never neutralizes or quotes a cell itself. Only external
 * import: `../services/csv-cell` (import-free, no I/O — D16).
 */
import { CSV_LINE_TERMINATOR, quoteRfc4180, sanitizeCsvCell, sanitizeCsvRow, stringifyCsvValue } from '../services/csv-cell'
import { TASK_FIELD_LIMITS, type TaskFieldDefinition } from './task-fields'
import { taskProjectionColumns, type TaskProjectionColumn } from './task-projection'

// RULED(2026-10-09): [S10] CSV only (no xlsx).
// ASSUMPTION(task-e): [D11] an absent `format` means CSV.
export const TASK_EXPORT_FORMATS = ['csv'] as const
export type TaskExportFormat = (typeof TASK_EXPORT_FORMATS)[number]

// ASSUMPTION(task-e, own choice): the body starts with a UTF-8 byte-order mark so that spreadsheet
// applications read CJK text correctly.
export const TASK_EXPORT_CSV_BOM = '\uFEFF'

/** `?format=`: absent ⇒ csv; exactly `'csv'` ⇒ csv; anything else ⇒ `unsupported_format`. */
export function parseTaskExportFormat(raw: unknown): { ok: true; format: TaskExportFormat } | { ok: false; reason: 'unsupported_format' } {
  if (raw === undefined || raw === 'csv') return { ok: true, format: 'csv' }
  return { ok: false, reason: 'unsupported_format' }
}

const LIST_ID_RE = /^tlst_[A-Za-z0-9]+$/

// ASSUMPTION(task-e): [D11] a fixed file name: `task-list-<listId>.csv`.
export function taskExportFileName(listId: string): string {
  if (typeof listId !== 'string' || !LIST_ID_RE.test(listId)) {
    throw new TypeError('taskExportFileName: listId must be a generated list id (tlst_…)')
  }
  return `task-list-${listId}.csv`
}

export interface TaskExportCellContext {
  /** Display names for user ids in person columns; an id without a name is shown as the id. */
  userLabels?: ReadonlyMap<string, string>
  /** Task titles by projection record id, for the dependencies column. */
  recordTitles?: ReadonlyMap<string, string>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ASSUMPTION(task-e, own choice): multi-value cells are joined with ", "; person ids are shown by
// display name and dependency record ids by task title when the caller knows them.
/**
 * The TEXT of one cell, before neutralization and quoting (those happen in `buildTaskExportCsv`
 * through the shared helper). `null` / `undefined` ⇒ empty.
 */
export function formatTaskExportCell(value: unknown, column: TaskProjectionColumn, ctx: TaskExportCellContext = {}): string {
  const fn = 'formatTaskExportCell'
  if (!isPlainObject(column) || typeof column.type !== 'string') throw new TypeError(`${fn}: column must be a projection column`)
  if (!isPlainObject(ctx)) throw new TypeError(`${fn}: ctx must be an object`)
  const { userLabels, recordTitles } = ctx as TaskExportCellContext
  if ((userLabels !== undefined && !(userLabels instanceof Map)) || (recordTitles !== undefined && !(recordTitles instanceof Map))) {
    throw new TypeError(`${fn}: ctx.userLabels and ctx.recordTitles must be Maps`)
  }
  if (value === null || value === undefined) return ''
  const labelOf = (item: unknown): string => {
    if (typeof item === 'string' && column.type === 'person') return userLabels?.get(item) ?? item
    if (typeof item === 'string' && column.type === 'link') return recordTitles?.get(item) ?? item
    return stringifyCsvValue(item)
  }
  if (Array.isArray(value)) return value.map(labelOf).join(', ')
  return labelOf(value)
}

// ASSUMPTION(task-e, own choice): a dateTime cell keeps the projected value (an ISO instant in UTC)
// and its header says so: `<label> (UTC)`. The pack names no time zone for the export; the
// alternatives (the task's own zone, the viewer's zone) are an owner question in the design doc.
function headerLabel(column: TaskProjectionColumn): string {
  return column.type === 'dateTime' ? `${column.label} (UTC)` : column.label
}

/** A value the task number codec can produce: a finite JSON number with |x| < 1e15. */
function isCodecNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < TASK_FIELD_LIMITS.maxNumberMagnitudeExclusive
}

// ASSUMPTION(task-e, own choice): in a number column, a number the field codec can produce is written
// as that number — through the shared RFC 4180 quoting only, without the lead-character
// neutralization — so a spreadsheet reads -5 as a number, not as the text '-5. Its text holds only
// digits, a sign, a point and an exponent, never author text (the S10 rule is about author text).
// Every other cell goes through `sanitizeCsvCell`; D11, which the ruled S10 cites, says every cell,
// so this is on the design doc's deviation list and waits for the owner.
function exportCell(value: unknown, column: TaskProjectionColumn, ctx: TaskExportCellContext): string {
  if (column.type === 'number' && isCodecNumber(value)) return quoteRfc4180(stringifyCsvValue(value))
  return sanitizeCsvCell(formatTaskExportCell(value, column, ctx))
}

/**
 * The whole CSV body: BOM, then the header (column labels; a dateTime column's label ends with
 * " (UTC)") and one line per row, every cell through the shared helpers (`exportCell`), lines joined
 * and terminated with CRLF. `rows` are projected rows of this list (`projectTaskRow` output); the
 * dependencies column shows predecessor titles taken from these same rows.
 */
export function buildTaskExportCsv(input: {
  listId: string
  dateColumnType: 'date' | 'dateTime'
  groupNames: readonly string[]
  boundFields: readonly TaskFieldDefinition[]
  rows: readonly { recordId: string; data: Record<string, unknown> }[]
  userLabels?: ReadonlyMap<string, string>
}): string {
  const fn = 'buildTaskExportCsv'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  const columns = taskProjectionColumns({
    listId: input.listId,
    dateColumnType: input.dateColumnType,
    groupNames: input.groupNames,
    boundFields: input.boundFields,
  })
  if (!Array.isArray(input.rows) || input.rows.some((row) => !isPlainObject(row) || typeof row.recordId !== 'string' || !isPlainObject(row.data))) {
    throw new TypeError(`${fn}: rows must be an array of { recordId, data }`)
  }
  if (input.userLabels !== undefined && !(input.userLabels instanceof Map)) throw new TypeError(`${fn}: userLabels must be a Map`)
  const titleColumn = columns.find((column) => column.key === 'title') as TaskProjectionColumn
  const recordTitles = new Map<string, string>()
  for (const row of input.rows) {
    const title = row.data[titleColumn.fieldId]
    if (typeof title === 'string') recordTitles.set(row.recordId, title)
  }
  const ctx: TaskExportCellContext = { userLabels: input.userLabels, recordTitles }
  const lines = [sanitizeCsvRow(columns.map(headerLabel))]
  for (const row of input.rows) {
    lines.push(columns.map((column) => exportCell(row.data[column.fieldId], column, ctx)).join(','))
  }
  return `${TASK_EXPORT_CSV_BOM}${lines.join(CSV_LINE_TERMINATOR)}${CSV_LINE_TERMINATOR}`
}
