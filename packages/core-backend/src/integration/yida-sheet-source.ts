import type { Request } from 'express'

/**
 * YiDa standardization slice Y2: prepare a draft from a multitable sheet or view instead of pasted rowsText.
 *
 * The read runs with the OWNER'S OWN multitable permissions, through the same permission primitives the grid
 * read path (`GET /api/multitable/view`) and the export path use: sheet read capability (and export capability,
 * since the rows leave MetaSheet towards YiDa), sheet liveness, the People-sheet bound, field visibility and
 * per-subject field permissions, record permissions and row-level read deny, and the view's filter. There is
 * no elevated or plugin-scoped read. Nothing read here is logged; errors are fixed codes only.
 *
 * The result is EXACTLY the rowsText shape the existing plan builder consumes (a JSON array of objects keyed by
 * the config's `fieldMap[].source` names), so the draft that follows is the draft the same pasted rowsText would
 * have produced (parity is tested). Bounded: at most MAX_SCAN records are read, at most MAX_ROWS rows and
 * MAX_TEXT_BYTES bytes of rowsText may result; past a bound the request is refused, never truncated.
 */
export const YIDA_SHEET_SOURCE_LIMITS = Object.freeze({ maxScan: 2000, maxRows: 100, maxColumns: 64, maxTextBytes: 128 * 1024 })
// Only plainly stored scalar columns. Computed (formula/lookup/rollup), relational (link/person), file,
// multi-value and rich columns are refused rather than coerced.
export const YIDA_SHEET_SOURCE_FIELD_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'boolean', 'select', 'date',
  'currency', 'percent', 'rating', 'url', 'email', 'phone'])
const COMPUTED_FILTER_TYPES = new Set(['formula', 'lookup', 'rollup'])
const IDENTIFIER = /^[\p{L}\p{N}_-]{1,128}$/u

export type YidaSheetSourceCode = 'INPUT' | 'DENIED' | 'NOT_FOUND' | 'LIMIT' | 'UNSUPPORTED' | 'UNAVAILABLE'
const CODES = new Set<unknown>(['INPUT', 'DENIED', 'NOT_FOUND', 'LIMIT', 'UNSUPPORTED', 'UNAVAILABLE'])
const ownErrors = new WeakMap<object, YidaSheetSourceCode>()
export class YidaSheetSourceError extends Error {
  readonly code: string
  constructor(code: unknown) {
    const fixed = (CODES.has(code) ? code : 'UNAVAILABLE') as YidaSheetSourceCode
    super(`YIDA_SHEET_SOURCE_${fixed}`)
    this.name = 'YidaSheetSourceError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}
export function yidaSheetSourceErrorCode(error: unknown): string | undefined {
  const code = ownErrors.get(error as object)
  return code === undefined ? undefined : `YIDA_SHEET_SOURCE_${code}`
}
function fail(code: YidaSheetSourceCode): never { throw new YidaSheetSourceError(code) }

export type YidaSheetSourceColumn = Readonly<{ fieldId: string; source: string }>
export type YidaSheetSourceInput = Readonly<{ sheetId: string; viewId?: string; columns: readonly YidaSheetSourceColumn[] }>
export type YidaSheetSourceField = Readonly<{ id: string; type: string; property?: unknown }>
export type YidaSheetSourceAccess = Readonly<{
  userId: string | null; isAdminRole: boolean; canRead: boolean; canExport: boolean
  live: boolean; bounded: boolean; capabilities: unknown
}>
type FilterNode = unknown
type FilterLeaf = Readonly<{ fieldId: string }>
export type YidaSheetSourceDependencies = Readonly<{
  resolveAccess(req: Request, sheetId: string): Promise<YidaSheetSourceAccess>
  loadFields(sheetId: string): Promise<readonly YidaSheetSourceField[]>
  readableFieldIds(sheetId: string, userId: string, fields: readonly YidaSheetSourceField[], capabilities: unknown): Promise<ReadonlySet<string>>
  loadView(viewId: string): Promise<Readonly<{ sheetId: string; filterInfo: unknown }> | null>
  loadRecords(sheetId: string, limit: number): Promise<readonly Readonly<{ id: string; data: unknown }>[]>
  readableRecordIds(sheetId: string, userId: string, isAdminRole: boolean, recordIds: readonly string[], capabilities: unknown): Promise<ReadonlySet<string>>
  filter: Readonly<{
    parse(filterInfo: unknown): FilterNode | null
    prune(node: FilterNode, keep: (leaf: FilterLeaf) => boolean): FilterNode | null
    leaves(node: FilterNode): readonly FilterLeaf[]
    evaluate(node: FilterNode, leaf: (leaf: FilterLeaf) => boolean): boolean
    leafMatches(fieldType: string, value: unknown, leaf: FilterLeaf): boolean
    effectiveType(field: YidaSheetSourceField): string
  }>
}>

function literal(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('INPUT')
  return value
}
/** Closed, values-free capture of the request's `source` object (route body). */
export function parseYidaSheetSourceInput(value: unknown): YidaSheetSourceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INPUT')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail('INPUT')
  const row = value as Record<string, unknown>
  const keys = Object.keys(row)
  if (keys.some(key => !['kind', 'sheetId', 'viewId', 'columns'].includes(key))
    || row.kind !== 'sheet' || !Object.hasOwn(row, 'sheetId') || !Object.hasOwn(row, 'columns')) fail('INPUT')
  const sheetId = literal(row.sheetId)
  const viewId = Object.hasOwn(row, 'viewId') ? literal(row.viewId) : undefined
  if (!Array.isArray(row.columns) || row.columns.length < 1 || row.columns.length > YIDA_SHEET_SOURCE_LIMITS.maxColumns) fail('INPUT')
  const fieldIds = new Set<string>(), sources = new Set<string>()
  const columns = row.columns.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('INPUT')
    const column = item as Record<string, unknown>
    const names = Object.keys(column)
    if (names.length !== 2 || !Object.hasOwn(column, 'fieldId') || !Object.hasOwn(column, 'source')) fail('INPUT')
    const fieldId = literal(column.fieldId), source = literal(column.source)
    if (!IDENTIFIER.test(source) || fieldIds.has(fieldId) || sources.has(source)) fail('INPUT')
    fieldIds.add(fieldId); sources.add(source)
    return Object.freeze({ fieldId, source })
  })
  return Object.freeze({ sheetId, ...(viewId === undefined ? {} : { viewId }), columns: Object.freeze(columns) })
}

function cell(value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  fail('UNSUPPORTED')
}

/**
 * Reads the mapped columns of the owner-visible rows and returns rowsText for the existing draft compiler.
 * Never returns record ids or values other than inside rowsText, and never logs.
 */
export async function readYidaSheetSourceRows(req: Request, input: YidaSheetSourceInput,
  dependencies: YidaSheetSourceDependencies): Promise<Readonly<{ rowsText: string; rowCount: number }>> {
  try {
    const access = await dependencies.resolveAccess(req, input.sheetId)
    if (!access.userId) fail('DENIED')
    // No read and no export = no rows towards YiDa. Liveness answers after the capability (no oracle).
    if (!access.canRead || !access.canExport) fail('DENIED')
    if (!access.live) fail('NOT_FOUND')
    // The People system sheet is never bulk-exported (export path parity).
    if (access.bounded) fail('DENIED')
    const fields = await dependencies.loadFields(input.sheetId)
    const byId = new Map(fields.map(field => [field.id, field] as const))
    const readable = await dependencies.readableFieldIds(input.sheetId, access.userId, fields, access.capabilities)
    for (const column of input.columns) {
      const field = byId.get(column.fieldId)
      // Unknown and unreadable look the same: the column cannot be used.
      if (!field || !readable.has(field.id)) fail('INPUT')
      if (!YIDA_SHEET_SOURCE_FIELD_TYPES.has(field.type)) fail('UNSUPPORTED')
    }
    let filter: FilterNode | null = null
    if (input.viewId !== undefined) {
      const view = await dependencies.loadView(input.viewId)
      if (!view || view.sheetId !== input.sheetId) fail('NOT_FOUND')
      const parsed = dependencies.filter.parse(view.filterInfo)
      // Same selection rule as the grid: a leaf on a field the owner cannot read is treated as absent.
      filter = parsed ? dependencies.filter.prune(parsed, leaf => byId.has(leaf.fieldId) && readable.has(leaf.fieldId)) : null
      if (filter && dependencies.filter.leaves(filter).some(leaf => {
        const field = byId.get(leaf.fieldId)
        return !field || COMPUTED_FILTER_TYPES.has(field.type) || COMPUTED_FILTER_TYPES.has(dependencies.filter.effectiveType(field))
      })) fail('UNSUPPORTED')
    }
    const records = await dependencies.loadRecords(input.sheetId, YIDA_SHEET_SOURCE_LIMITS.maxScan + 1)
    if (records.length > YIDA_SHEET_SOURCE_LIMITS.maxScan) fail('LIMIT')
    const allowed = await dependencies.readableRecordIds(input.sheetId, access.userId, access.isAdminRole,
      records.map(record => record.id), access.capabilities)
    const rows: Record<string, string | number | boolean>[] = []
    for (const record of records) {
      if (!allowed.has(record.id)) continue
      const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
        ? record.data as Record<string, unknown> : {}
      if (filter && !dependencies.filter.evaluate(filter, leaf => {
        const field = byId.get(leaf.fieldId)!
        return dependencies.filter.leafMatches(dependencies.filter.effectiveType(field), data[leaf.fieldId], leaf)
      })) continue
      const row: Record<string, string | number | boolean> = {}
      for (const column of input.columns) {
        const value = cell(Object.hasOwn(data, column.fieldId) ? data[column.fieldId] : undefined)
        if (value !== undefined) row[column.source] = value
      }
      rows.push(row)
      if (rows.length > YIDA_SHEET_SOURCE_LIMITS.maxRows) fail('LIMIT')
    }
    if (rows.length === 0) fail('INPUT')
    const rowsText = JSON.stringify(rows)
    if (Buffer.byteLength(rowsText, 'utf8') > YIDA_SHEET_SOURCE_LIMITS.maxTextBytes) fail('LIMIT')
    return Object.freeze({ rowsText, rowCount: rows.length })
  } catch (error) {
    // Never forward a dependency message, row, id or value.
    throw new YidaSheetSourceError(ownErrors.get(error as object) ?? 'UNAVAILABLE')
  }
}
