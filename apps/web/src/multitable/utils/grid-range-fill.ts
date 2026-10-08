import type { MetaField, MetaRecord } from '../types'
import { isFieldAlwaysReadOnly, isPropertyHiddenField } from './field-permissions'

export interface CellPoint { row: number; col: number }
export interface CellRange { top: number; left: number; bottom: number; right: number }
export type FillMode = 'copy' | 'series'
export interface RangeChange { recordId: string; fieldId: string; value: unknown; expectedVersion: number }
type ErrorCode = 'INVALID_RANGE' | 'TOO_LARGE' | 'INVALID_CLIPBOARD' | 'OUT_OF_BOUNDS'
  | 'READ_ONLY' | 'INVALID_VALUE' | 'INCOMPATIBLE_TYPE' | 'INVALID_SERIES'
export class RangeOperationError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode) { super(code); this.name = 'RangeOperationError'; this.code = code }
}
function fail(code: ErrorCode): never { throw new RangeOperationError(code) }
const LIMIT = 1000
const DAY = 86_400_000
const WRITABLE = new Set(['string', 'number', 'boolean', 'date', 'dateTime', 'select'])

export function rangeFromPoints(a: CellPoint, b: CellPoint): CellRange {
  return { top: Math.min(a.row, b.row), left: Math.min(a.col, b.col), bottom: Math.max(a.row, b.row), right: Math.max(a.col, b.col) }
}
export function rangeContains(range: CellRange, point: CellPoint): boolean {
  return point.row >= range.top && point.row <= range.bottom && point.col >= range.left && point.col <= range.right
}
export function rangeSize(range: CellRange): number { return (range.bottom - range.top + 1) * (range.right - range.left + 1) }

function matrixShape(matrix: unknown[][]): { height: number; width: number } {
  const height = matrix.length, width = matrix[0]?.length ?? 0
  if (!height || !width || matrix.some(row => row.length !== width)) fail('INVALID_CLIPBOARD')
  if (height * width > LIMIT) fail('TOO_LARGE')
  return { height, width }
}

/** TSV quoting uses doubled quotes; a single optional final record terminator is not an extra row. */
export function parseClipboardMatrix(text: string): string[][] {
  const matrix: string[][] = []
  let row: string[] = [], cell = '', quoted = false, closed = false, count = 0
  const pushCell = () => { row.push(cell); cell = ''; closed = false; if (++count > LIMIT) fail('TOO_LARGE') }
  const pushRow = () => { pushCell(); matrix.push(row); row = []; if (matrix.length > LIMIT) fail('TOO_LARGE') }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ }
        else { quoted = false; closed = true }
      } else cell += char
      continue
    }
    if (char === '\t') { pushCell(); continue }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++
      pushRow()
      if (i === text.length - 1) { matrixShape(matrix); return matrix }
      continue
    }
    if (closed) fail('INVALID_CLIPBOARD')
    if (char === '"') {
      if (cell.length) fail('INVALID_CLIPBOARD')
      quoted = true
    } else cell += char
  }
  if (quoted) fail('INVALID_CLIPBOARD')
  pushRow()
  matrixShape(matrix)
  return matrix
}

export function serializeClipboardMatrix(values: unknown[][]): string {
  matrixShape(values)
  return values.map(row => row.map(value => {
    const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
    return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }).join('\t')).join('\n')
}

function dateOrdinal(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('INVALID_VALUE')
  const [year, month, day] = value.split('-').map(Number)
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) fail('INVALID_VALUE')
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) fail('INVALID_VALUE')
  return date.getTime() / DAY
}
function ordinalDate(value: number): string {
  if (!Number.isSafeInteger(value)) fail('INVALID_SERIES')
  const date = new Date(value * DAY)
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) fail('INVALID_SERIES')
  return date.toISOString().slice(0, 10)
}
function instant(value: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) fail('INVALID_VALUE')
  dateOrdinal(match[1])
  if (+match[2] > 23 || +match[3] > 59 || +(match[4] ?? 0) > 59) fail('INVALID_VALUE')
  const offset = match[5]
  if (offset !== 'Z' && (+offset.slice(1, 3) > 23 || +offset.slice(4) > 59)) fail('INVALID_VALUE')
  const result = Date.parse(value)
  if (!Number.isFinite(result)) fail('INVALID_VALUE')
  return result
}
function typedValue(value: unknown, field: MetaField): unknown {
  if (value == null || value === '') {
    if (field.required === true || field.property?.required === true) fail('INVALID_VALUE')
    return value === '' && field.type === 'string' ? '' : null
  }
  switch (field.type) {
    case 'string': if (typeof value !== 'string') fail('INVALID_VALUE'); return value
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_VALUE'); return value
    case 'boolean': if (typeof value !== 'boolean') fail('INVALID_VALUE'); return value
    case 'date': dateOrdinal(value); return value
    case 'dateTime':
      if (typeof value === 'number' && Number.isFinite(new Date(value).getTime())) return value
      if (typeof value !== 'string') fail('INVALID_VALUE')
      instant(value); return value
    case 'select': if (!field.options?.some(option => option.value === value)) fail('INVALID_VALUE'); return value
    default: return fail('READ_ONLY')
  }
}
function clipboardValue(text: string, field: MetaField): unknown {
  if (text === '') return typedValue(null, field)
  let value: unknown = text
  if (field.type === 'number') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) fail('INVALID_VALUE')
    value = Number(text)
  } else if (field.type === 'boolean') {
    if (!/^(true|false)$/i.test(text)) fail('INVALID_VALUE')
    value = text.toLowerCase() === 'true'
  } else if (field.type === 'dateTime') value = instant(text)
  return typedValue(value, field)
}

interface PlanContext {
  rows: MetaRecord[]
  fields: MetaField[]
  canWrite: (recordId: string, field: MetaField) => boolean
}
function checkRange(range: CellRange, context: PlanContext) {
  if (![range.top, range.left, range.bottom, range.right].every(Number.isSafeInteger)
    || range.top < 0 || range.left < 0 || range.bottom < range.top || range.right < range.left) fail('INVALID_RANGE')
  if (range.bottom >= context.rows.length || range.right >= context.fields.length) fail('OUT_OF_BOUNDS')
}
function changeAt(context: PlanContext, rowIndex: number, col: number, value: unknown): RangeChange {
  const row = context.rows[rowIndex], field = context.fields[col]
  if (row.locked || isFieldAlwaysReadOnly(field) || isPropertyHiddenField(field)
    || !WRITABLE.has(field.type) || !context.canWrite(row.id, field)) fail('READ_ONLY')
  if (!Number.isSafeInteger(row.version) || row.version < 0) fail('INVALID_VALUE')
  return { recordId: row.id, fieldId: field.id, value: typedValue(value, field), expectedVersion: row.version }
}

export function planRangePaste(args: PlanContext & { target: CellRange; matrix: string[][] }): RangeChange[] {
  checkRange(args.target, args)
  const { width, height } = matrixShape(args.matrix)
  if (args.matrix.some(row => row.some(value => typeof value !== 'string'))) fail('INVALID_CLIPBOARD')
  const target = rangeSize(args.target) === 1
    ? { ...args.target, bottom: args.target.top + height - 1, right: args.target.left + width - 1 } : args.target
  checkRange(target, args)
  if (rangeSize(target) > LIMIT) fail('TOO_LARGE')
  if ((target.bottom - target.top + 1) % height || (target.right - target.left + 1) % width) fail('INVALID_RANGE')
  const changes: RangeChange[] = []
  for (let row = target.top; row <= target.bottom; row++) {
    for (let col = target.left; col <= target.right; col++) {
      const text = args.matrix[(row - target.top) % height][(col - target.left) % width]
      changes.push(changeAt(args, row, col, clipboardValue(text, args.fields[col])))
    }
  }
  return changes
}

function series(values: unknown[], field: MetaField): (index: number) => unknown {
  if (field.type !== 'number' && field.type !== 'date') fail('INVALID_SERIES')
  let numbers: number[]
  try {
    numbers = values.map(value => {
      if (field.type === 'date') return dateOrdinal(value)
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_SERIES')
      return value
    })
  } catch { return fail('INVALID_SERIES') }
  const step = numbers.length === 1 ? 1 : numbers[1] - numbers[0]
  if (!Number.isFinite(step)) fail('INVALID_SERIES')
  for (let i = 2; i < numbers.length; i++) {
    const expected = numbers[0] + i * step
    const tolerance = 8 * Number.EPSILON * Math.max(1, Math.abs(expected), Math.abs(numbers[i]))
    if (Math.abs(numbers[i] - expected) > tolerance) fail('INVALID_SERIES')
  }
  return index => {
    const value = numbers[0] + index * step
    if (!Number.isFinite(value)) fail('INVALID_SERIES')
    return field.type === 'date' ? ordinalDate(value) : value
  }
}
const modulo = (value: number, length: number) => ((value % length) + length) % length

export function planRangeFill(args: PlanContext & { source: CellRange; target: CellRange; mode: FillMode }): RangeChange[] {
  const { source, target } = args
  checkRange(source, args); checkRange(target, args)
  if (args.mode !== 'copy' && args.mode !== 'series') fail('INVALID_RANGE')
  if (target.top > source.top || target.left > source.left || target.bottom < source.bottom || target.right < source.right) fail('INVALID_RANGE')
  const vertical = target.top !== source.top || target.bottom !== source.bottom
  const horizontal = target.left !== source.left || target.right !== source.right
  if (vertical && horizontal) fail('INVALID_RANGE')
  if (rangeSize(source) > LIMIT || rangeSize(target) - rangeSize(source) > LIMIT) fail('TOO_LARGE')
  if (!vertical && !horizontal) return []
  const height = source.bottom - source.top + 1, width = source.right - source.left + 1
  const generators = new Map<number, (index: number) => unknown>()
  if (args.mode === 'series') {
    for (let axis = vertical ? source.left : source.top; axis <= (vertical ? source.right : source.bottom); axis++) {
      const values: unknown[] = []
      const firstField = args.fields[vertical ? axis : source.left]
      for (let i = 0; i < (vertical ? height : width); i++) {
        const row = vertical ? source.top + i : axis, col = vertical ? axis : source.left + i
        if (args.fields[col].type !== firstField.type) fail('INVALID_SERIES')
        values.push(args.rows[row].data[args.fields[col].id])
      }
      generators.set(axis, series(values, firstField))
    }
  }
  const changes: RangeChange[] = []
  for (let row = target.top; row <= target.bottom; row++) {
    for (let col = target.left; col <= target.right; col++) {
      if (rangeContains(source, { row, col })) continue
      const sourceCol = source.left + modulo(col - source.left, width)
      if (args.fields[sourceCol].type !== args.fields[col].type) fail('INCOMPATIBLE_TYPE')
      const value = args.mode === 'series'
        ? generators.get(vertical ? col : row)!(vertical ? row - source.top : col - source.left)
        : args.rows[source.top + modulo(row - source.top, height)].data[args.fields[sourceCol].id]
      changes.push(changeAt(args, row, col, value))
    }
  }
  return changes
}
