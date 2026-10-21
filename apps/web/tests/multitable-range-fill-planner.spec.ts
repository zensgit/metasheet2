import { describe, expect, it } from 'vitest'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import {
  RangeOperationError, parseClipboardMatrix, serializeClipboardMatrix,
  planRangeFill, planRangePaste, rangeContains, rangeFromPoints, rangeSize,
  cloneRangeValue, isRangeWritableFieldType, normalizeRangeValue, type CellRange,
} from '../src/multitable/utils/grid-range-fill'

const writable = () => true
const cell = (row = 0, col = 0): CellRange => ({ top: row, bottom: row, left: col, right: col })
function field(type: MetaField['type'] = 'string', extra: Partial<MetaField> = {}): MetaField {
  return { id: 'f0', name: 'Value', type, ...extra }
}
function records(values: unknown[][]): MetaRecord[] {
  return values.map((values, row) => ({
    id: `r${row}`, version: row + 1,
    data: Object.fromEntries(values.map((value, col) => [`f${col}`, value])),
  }))
}
function expectCode(run: () => unknown, code: string) {
  try { run() } catch (error) {
    expect(error).toBeInstanceOf(RangeOperationError)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error('EXPECTED_RANGE_REJECTION')
}
function series(values: unknown[], type: MetaField['type'], source: CellRange, target: CellRange) {
  return planRangeFill({ rows: records(values.map(value => [value])), fields: [field(type)], source, target, mode: 'series', canWrite: writable })
}
function paste(matrix: string[][], targetField = field()) {
  return planRangePaste({ rows: records([[null], [null]]), fields: [targetField], target: cell(), matrix, canWrite: writable })
}

describe('range geometry and strict clipboard contract', () => {
  it('normalizes points, includes boundaries, and counts all cells', () => {
    const range = rangeFromPoints({ row: 4, col: 3 }, { row: 1, col: 2 })
    expect(range).toEqual({ top: 1, left: 2, bottom: 4, right: 3 })
    expect(rangeSize(range)).toBe(8)
    expect(rangeContains(range, { row: 1, col: 2 })).toBe(true)
    expect(rangeContains(range, { row: 4, col: 3 })).toBe(true)
    expect(rangeContains(range, { row: 0, col: 2 })).toBe(false)
  })

  it('parses quoted tabs, newlines, escaped quotes, CRLF and one optional final terminator', () => {
    expect(parseClipboardMatrix('"a\tb"\t"line1\nline2"\r\n"say ""yes"""\tz\r\n')).toEqual([
      ['a\tb', 'line1\nline2'], ['say "yes"', 'z'],
    ])
    expect(parseClipboardMatrix('a\tb\nc\td')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseClipboardMatrix('a\tb\nc\td\n')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseClipboardMatrix('a\t\r\nb\t\r\n')).toEqual([['a', ''], ['b', '']])
    expect(parseClipboardMatrix('')).toEqual([['']])
  })

  it('roundtrips scalar cells with escaped delimiters and empty nullable values', () => {
    const values = [['a\tb', 'quote"', 'line\nnext', null], ['plain', 0, false, '']]
    expect(parseClipboardMatrix(serializeClipboardMatrix(values))).toEqual([
      ['a\tb', 'quote"', 'line\nnext', ''], ['plain', '0', 'false', ''],
    ])
  })

  it.each(['a\tb\nc', '"unterminated', '"a"suffix\tb', 'a"b\tc', 'a\tb\n\n'])('rejects malformed/ragged TSV %j', text => {
    expectCode(() => parseClipboardMatrix(text), 'INVALID_CLIPBOARD')
  })

  it('caps destination matrices at 1000 cells without truncation', () => {
    const rows = records(Array.from({ length: 1001 }, () => [null]))
    const matrix = Array.from({ length: 1000 }, () => ['x'])
    expect(planRangePaste({ rows, fields: [field()], target: cell(), matrix, canWrite: writable })).toHaveLength(1000)
    expectCode(() => planRangePaste({ rows, fields: [field()], target: cell(), matrix: [...matrix, ['x']], canWrite: writable }), 'TOO_LARGE')
  })
})

describe('copy tiling and destination identity', () => {
  it('uses positive modulo on odd reverse offsets: A B at rows 3..4 extends upward as B A B', () => {
    const rows = records([['old0'], ['old1'], ['old2'], ['A'], ['B']])
    const before = JSON.stringify(rows)
    expect(planRangeFill({ rows, fields: [field()], source: { top: 3, bottom: 4, left: 0, right: 0 },
      target: { top: 0, bottom: 4, left: 0, right: 0 }, mode: 'copy', canWrite: writable })).toEqual([
      { recordId: 'r0', fieldId: 'f0', value: 'B', expectedVersion: 1 },
      { recordId: 'r1', fieldId: 'f0', value: 'A', expectedVersion: 2 },
      { recordId: 'r2', fieldId: 'f0', value: 'B', expectedVersion: 3 },
    ])
    expect(JSON.stringify(rows)).toBe(before)
  })

  it.each(['down', 'right', 'left'])('tiles a two-cell source %s without writing the source', direction => {
    const horizontal = direction !== 'down'
    const rows = records(horizontal ? [['A', 'B', 'old', 'old']] : [['A'], ['B'], ['old'], ['old']])
    const fields = horizontal ? Array.from({ length: 4 }, (_, col) => field('string', { id: `f${col}` })) : [field()]
    if (direction === 'left') rows[0].data = { f0: 'old', f1: 'old', f2: 'A', f3: 'B' }
    const source = horizontal
      ? { top: 0, bottom: 0, left: direction === 'left' ? 2 : 0, right: direction === 'left' ? 3 : 1 }
      : { top: 0, bottom: 1, left: 0, right: 0 }
    const target = { top: 0, bottom: horizontal ? 0 : 3, left: 0, right: horizontal ? 3 : 0 }
    const result = planRangeFill({ rows, fields, source, target, mode: 'copy', canWrite: writable })
    expect(result).toEqual(horizontal ? [
      { recordId: 'r0', fieldId: direction === 'left' ? 'f0' : 'f2', value: 'A', expectedVersion: 1 },
      { recordId: 'r0', fieldId: direction === 'left' ? 'f1' : 'f3', value: 'B', expectedVersion: 1 },
    ] : [
      { recordId: 'r2', fieldId: 'f0', value: 'A', expectedVersion: 3 },
      { recordId: 'r3', fieldId: 'f0', value: 'B', expectedVersion: 4 },
    ])
  })

  it('tiles a clipboard rectangle only when target dimensions are whole multiples', () => {
    const rows = records([[null, null], [null, null], [null, null], [null, null]])
    const fields = [field(), field('string', { id: 'f1' })]
    const target = { top: 0, left: 0, bottom: 3, right: 1 }
    const args = { rows, fields, target, matrix: [['A', 'B'], ['C', 'D']], canWrite: writable }
    expect(planRangePaste(args).map(change => change.value)).toEqual(['A', 'B', 'C', 'D', 'A', 'B', 'C', 'D'])
    expectCode(() => planRangePaste({ ...args, target: { ...target, bottom: 2 } }), 'INVALID_RANGE')
  })

  it('rejects diagonal fill, out-of-bounds destinations and incompatible field types', () => {
    const rows = records([[1, 'x'], [2, 'y']])
    const fields = [field('number'), field('string', { id: 'f1' })]
    const args = { rows, fields, source: cell(), target: { top: 0, left: 0, bottom: 1, right: 1 }, mode: 'copy' as const, canWrite: writable }
    expectCode(() => planRangeFill(args), 'INVALID_RANGE')
    expectCode(() => planRangeFill({ ...args, target: { top: 0, bottom: 0, left: 0, right: 2 } }), 'OUT_OF_BOUNDS')
    expectCode(() => planRangeFill({ ...args, target: { top: 0, bottom: 0, left: 0, right: 1 } }), 'INCOMPATIBLE_TYPE')
    expectCode(() => planRangeFill({ ...args, mode: 'COPY' as never }), 'INVALID_RANGE')
  })

  it('allows 1000 cells outside a 1000-cell source but rejects either limit being exceeded', () => {
    const rows = records(Array.from({ length: 2001 }, () => ['seed']))
    const args = { rows, fields: [field()], source: { top: 0, bottom: 999, left: 0, right: 0 },
      target: { top: 0, bottom: 1999, left: 0, right: 0 }, mode: 'copy' as const, canWrite: writable }
    const result = planRangeFill(args)
    expect(result).toHaveLength(1000)
    expect(result[0]).toEqual({ recordId: 'r1000', fieldId: 'f0', value: 'seed', expectedVersion: 1001 })
    expectCode(() => planRangeFill({ ...args, target: { ...args.target, bottom: 2000 } }), 'TOO_LARGE')
    expectCode(() => planRangeFill({ ...args, source: { ...args.source, bottom: 1000 } }), 'TOO_LARGE')
  })
})

describe('numeric and civil-date series', () => {
  it.each([
    [[2, 4, null, null], [6, 8]],
    [[4, 2, null, null], [0, -2]],
    [[5, 5, null, null], [5, 5]],
  ])('extends positive, negative and zero steps for %j', (values, expected) => {
    const result = series(values, 'number', { top: 0, bottom: 1, left: 0, right: 0 }, { top: 0, bottom: 3, left: 0, right: 0 })
    expect(result).toEqual([
      { recordId: 'r2', fieldId: 'f0', value: expected[0], expectedVersion: 3 },
      { recordId: 'r3', fieldId: 'f0', value: expected[1], expectedVersion: 4 },
    ])
  })

  it('uses a single seed step of one and extrapolates reverse numeric series', () => {
    expect(series([10, null, null], 'number', cell(), { top: 0, bottom: 2, left: 0, right: 0 }).map(change => change.value)).toEqual([11, 12])
    expect(series([null, null, 2, 4], 'number', { top: 2, bottom: 3, left: 0, right: 0 }, { top: 0, bottom: 3, left: 0, right: 0 }).map(change => change.value)).toEqual([-2, 0])
  })

  it('accepts constant decimal steps despite floating-point representation differences', () => {
    const result = series([0.1, 0.2, 0.3, null], 'number', { top: 0, bottom: 2, left: 0, right: 0 }, { top: 0, bottom: 3, left: 0, right: 0 })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ recordId: 'r3', fieldId: 'f0', expectedVersion: 4 })
    expect(result[0].value).toBeCloseTo(0.4, 12)
  })

  it('keeps each numeric source column an independent series', () => {
    expect(planRangeFill({ rows: records([[1, 10], [3, 15], [null, null]]),
      fields: [field('number'), field('number', { id: 'f1' })], source: { top: 0, bottom: 1, left: 0, right: 1 },
      target: { top: 0, bottom: 2, left: 0, right: 1 }, mode: 'series', canWrite: writable })).toEqual([
      { recordId: 'r2', fieldId: 'f0', value: 5, expectedVersion: 3 },
      { recordId: 'r2', fieldId: 'f1', value: 20, expectedVersion: 3 },
    ])
  })

  it('keeps horizontal source rows independent and rejects mixed types within that axis', () => {
    const rows = records([[1, 3, null, null], [10, 15, null, null]])
    const fields = Array.from({ length: 4 }, (_, col) => field('number', { id: `f${col}` }))
    const args = { rows, fields, source: { top: 0, bottom: 1, left: 0, right: 1 },
      target: { top: 0, bottom: 1, left: 0, right: 3 }, mode: 'series' as const, canWrite: writable }
    expect(planRangeFill(args)).toEqual([
      { recordId: 'r0', fieldId: 'f2', value: 5, expectedVersion: 1 },
      { recordId: 'r0', fieldId: 'f3', value: 7, expectedVersion: 1 },
      { recordId: 'r1', fieldId: 'f2', value: 20, expectedVersion: 2 },
      { recordId: 'r1', fieldId: 'f3', value: 25, expectedVersion: 2 },
    ])
    fields[1] = field('date', { id: 'f1' })
    expectCode(() => planRangeFill(args), 'INVALID_SERIES')
  })

  it('rejects floating-point drift beyond tolerance and nonfinite extrapolation', () => {
    expectCode(() => series([0.1, 0.2, 0.3000000001, null], 'number',
      { top: 0, bottom: 2, left: 0, right: 0 }, { top: 0, bottom: 3, left: 0, right: 0 }), 'INVALID_SERIES')
    expectCode(() => series([0, Number.MAX_VALUE, null], 'number',
      { top: 0, bottom: 1, left: 0, right: 0 }, { top: 0, bottom: 2, left: 0, right: 0 }), 'INVALID_SERIES')
  })

  it.each([{ values: [2, 4, 7, null] }, { values: [1, '2', null] }, { values: [1, Infinity, null] }])('rejects nonconstant, mixed or nonfinite numeric seeds %j', ({ values }) => {
    expect(() => series(values, 'number', { top: 0, bottom: values.length - 2, left: 0, right: 0 },
      { top: 0, bottom: values.length - 1, left: 0, right: 0 })).toThrow(RangeOperationError)
  })

  it.each([
    ['2024-02-28', '2024-02-29', '2024-03-01'],
    ['2023-02-28', '2023-03-01', '2023-03-02'],
    ['2024-12-31', '2025-01-01', '2025-01-02'],
    ['2024-03-09', '2024-03-10', '2024-03-11'],
    ['2024-11-02', '2024-11-03', '2024-11-04'],
  ])('advances civil dates from %s across leap/month/year/DST boundaries', (seed, first, second) => {
    expect(series([seed, null, null], 'date', cell(), { top: 0, bottom: 2, left: 0, right: 0 })).toEqual([
      { recordId: 'r1', fieldId: 'f0', value: first, expectedVersion: 2 },
      { recordId: 'r2', fieldId: 'f0', value: second, expectedVersion: 3 },
    ])
  })

  it('extrapolates dates upward with a negative destination offset', () => {
    expect(series([null, null, '2024-03-01', '2024-03-03'], 'date', { top: 2, bottom: 3, left: 0, right: 0 },
      { top: 0, bottom: 3, left: 0, right: 0 }).map(change => change.value)).toEqual(['2024-02-26', '2024-02-28'])
  })

  it.each(['2023-02-29', '03/01/2024', '9999-12-31'])('rejects invalid or overflowing date series %j', value => {
    expect(() => series([value, null], 'date', cell(), { top: 0, bottom: 1, left: 0, right: 0 })).toThrow(RangeOperationError)
  })

  it.each(['string', 'dateTime'] as const)('does not infer series from %s', type => {
    expectCode(() => series(['2024-01-01', null], type, cell(), { top: 0, bottom: 1, left: 0, right: 0 }), 'INVALID_SERIES')
  })
})

describe('typed clipboard conversion and whole-operation refusal', () => {
  it.each([
    ['number', '12.5', 12.5], ['number', '-1.25e2', -125], ['number', '+.5E+1', 5],
    ['boolean', 'true', true], ['boolean', 'false', false], ['boolean', 'TRUE', true], ['boolean', 'FALSE', false],
    ['date', '2024-02-29', '2024-02-29'], ['string', '001', '001'],
    ['dateTime', '2024-02-29T12:30:00Z', Date.parse('2024-02-29T12:30:00Z')],
    ['dateTime', '2024-02-29T20:30:00+08:00', Date.parse('2024-02-29T12:30:00Z')],
  ] as const)('converts %s explicitly from %j', (type, text, expected) => {
    expect(paste([[text]], field(type))).toEqual([{ recordId: 'r0', fieldId: 'f0', value: expected, expectedVersion: 1 }])
  })

  it.each(['number', 'boolean', 'date', 'string'] as const)('clears a nullable %s with an empty clipboard cell', type => {
    expect(paste([['']], field(type))).toEqual([{ recordId: 'r0', fieldId: 'f0', value: null, expectedVersion: 1 }])
    expectCode(() => paste([['']], field(type, { required: true })), 'INVALID_VALUE')
  })

  it.each([
    ['number', 'Infinity'], ['number', 'NaN'], ['number', '0x10'], ['number', '1e309'],
    ['number', ' 12'], ['number', '12 '], ['number', ' '],
    ['boolean', 'maybe'], ['date', '2023-02-29'], ['date', '02/29/2024'],
    ['dateTime', '2024-02-29T12:30:00'], ['dateTime', '2024-02-30T12:30:00Z'],
  ] as const)('rejects invalid %s value %j', (type, value) => {
    expectCode(() => paste([[value]], field(type)), 'INVALID_VALUE')
  })

  it('requires an existing select option for paste and repeat, without creating options', () => {
    const target = field('select', { options: [{ value: 'Open' }, { value: 'Closed' }] })
    expect(paste([['Open']], target)[0].value).toBe('Open')
    expectCode(() => paste([['New option']], target), 'INVALID_VALUE')
    expectCode(() => planRangeFill({ rows: records([['Open', 'Closed']]), fields: [target, field('select', { id: 'f1', options: [{ value: 'Closed' }] })],
      source: cell(), target: { top: 0, bottom: 0, left: 0, right: 1 }, mode: 'copy', canWrite: writable }), 'INVALID_VALUE')
    expect(target.options).toEqual([{ value: 'Open' }, { value: 'Closed' }])
  })

  it('preserves empty strings in typed repeat while empty clipboard cells become null', () => {
    expect(planRangeFill({ rows: records([[''], ['old']]), fields: [field()], source: cell(),
      target: { top: 0, bottom: 1, left: 0, right: 0 }, mode: 'copy', canWrite: writable })).toEqual([
      { recordId: 'r1', fieldId: 'f0', value: '', expectedVersion: 2 },
    ])
    expect(paste([['']])[0].value).toBeNull()
  })

  it.each<Partial<MetaField>>([
    { type: 'formula' }, { type: 'lookup' }, { type: 'rollup' }, { type: 'autoNumber' },
    { type: 'button' }, { type: 'createdTime' }, { type: 'modifiedTime' },
    { type: 'createdBy' }, { type: 'modifiedBy' }, { type: 'unknown' as never },
    { property: { readOnly: true } }, { property: { readonly: true } },
    { property: { mirrorOf: 'source' } }, { property: { hidden: true } }, { property: { visible: false } },
  ])('rejects forbidden field definitions %j', definition => {
    expectCode(() => paste([['x']], field('string', definition)), 'READ_ONLY')
  })

  it.each(['locked', 'permission'])('rejects the whole matrix on a %s row without mutating the writable neighbor', refusal => {
    const rows = records([['old'], ['old too']])
    if (refusal === 'locked') rows[1].locked = true
    const before = JSON.stringify(rows)
    expectCode(() => planRangePaste({ rows, fields: [field()], target: cell(), matrix: [['new'], ['new too']],
      canWrite: recordId => refusal !== 'permission' || recordId !== 'r1' }), 'READ_ONLY')
    expect(JSON.stringify(rows)).toBe(before)
  })
})

const editableExamples: Array<{ type: MetaField['type']; value: unknown; extra?: Partial<MetaField> }> = [
  { type: 'string', value: 'text' }, { type: 'number', value: 12.5 },
  { type: 'boolean', value: false }, { type: 'date', value: '2024-02-29' },
  { type: 'dateTime', value: '2024-02-29T12:30:00Z' },
  { type: 'select', value: 'Open', extra: { options: [{ value: 'Open' }] } },
  { type: 'multiSelect', value: ['A,B', 'line\nnext', 'quote"'],
    extra: { options: [{ value: 'A,B' }, { value: 'line\nnext' }, { value: 'quote"' }] } },
  { type: 'person', value: ['u1', 'u2'], extra: { property: { limitSingleRecord: false } } },
  { type: 'link', value: ['rec1', 'rec2'], extra: { property: { foreignSheetId: 'sheet2' } } },
  { type: 'attachment', value: ['attachment1', 'attachment2'] },
  { type: 'currency', value: 100.25 }, { type: 'percent', value: 0.25 },
  { type: 'rating', value: 4 }, { type: 'duration', value: 5400 },
  { type: 'url', value: 'https://example.test/path?q=a,b' },
  { type: 'email', value: 'person@example.test' }, { type: 'phone', value: '+86 123456789' },
  { type: 'barcode', value: '001234' }, { type: 'qrcode', value: 'hello,世界' },
  { type: 'location', value: { address: 'Room A,B', latitude: 30, longitude: 120 } },
  { type: 'longText', value: '<p>hello <b>world</b></p>', extra: { property: { rich: true } } },
]
function copyValue(value: unknown, targetField: MetaField) {
  return planRangeFill({ rows: records([[value], [null], [null]]), fields: [targetField],
    source: cell(), target: { top: 0, bottom: 2, left: 0, right: 0 }, mode: 'copy', canWrite: writable })
}

describe('all editable field copy values', () => {
  it.each(editableExamples)('copies canonical $type and independently roundtrips TSV', ({ type, value, extra }) => {
    const targetField = field(type, extra)
    const before = JSON.stringify(value)
    expect(copyValue(value, targetField).map(change => change.value)).toEqual([value, value])
    expect(isRangeWritableFieldType(type)).toBe(true)
    const across = planRangeFill({ rows: records([[value, null]]),
      fields: [targetField, { ...targetField, id: 'f1' }], source: cell(),
      target: { top: 0, bottom: 0, left: 0, right: 1 }, mode: 'copy', canWrite: writable })
    expect(across).toEqual([{ recordId: 'r0', fieldId: 'f1', value, expectedVersion: 1 }])
    const matrix = parseClipboardMatrix(serializeClipboardMatrix([[value]]))
    const expected = type === 'dateTime' ? Date.parse(value as string) : value
    expect(paste(matrix, targetField)[0].value).toEqual(expected)
    expect(JSON.stringify(value)).toBe(before)
  })

  it.each(['multiSelect', 'person', 'link', 'attachment'] as const)('clears optional %s arrays and refuses required arrays', type => {
    const targetField = field(type)
    expect(paste([['']], targetField)[0].value).toEqual([])
    expect(paste([['[]']], targetField)[0].value).toEqual([])
    expectCode(() => paste([['[]']], { ...targetField, required: true }), 'INVALID_VALUE')
    expectCode(() => copyValue([], { ...targetField, property: { required: true } }), 'INVALID_VALUE')
    expectCode(() => paste([['']], { ...targetField, required: true }), 'INVALID_VALUE')
  })

  it('checks destination multi-select options, including property-backed options, without splitting punctuation', () => {
    const targetField = field('multiSelect', { property: { options: [{ value: 'a,b' }, { value: 'c\nd' }] } })
    expect(paste([['["a,b","c\\nd"]']], targetField)[0].value).toEqual(['a,b', 'c\nd'])
    expectCode(() => paste([['["a,b","unknown"]']], targetField), 'INVALID_VALUE')
    expectCode(() => paste([['a,b']], targetField), 'INVALID_VALUE')
    const fields = [field('multiSelect', { options: [{ value: 'Open' }] }),
      field('multiSelect', { id: 'f1', options: [{ value: 'Closed' }] })]
    expectCode(() => planRangeFill({ rows: records([[['Open'], ['Closed']]]), fields,
      source: cell(), target: { top: 0, bottom: 0, left: 0, right: 1 }, mode: 'copy', canWrite: writable }), 'INVALID_VALUE')
  })

  it('enforces native person defaults, legacy person and target link cardinality', () => {
    expectCode(() => copyValue(['u1', 'u2'], field('person')), 'INVALID_VALUE')
    expect(copyValue(['u1'], field('person'))[0].value).toEqual(['u1'])
    expectCode(() => copyValue(['r1', 'r2'], field('link', { property: { refKind: 'user', limitSingleRecord: true } })), 'INVALID_VALUE')
    expectCode(() => copyValue(['r1', 'r2'], field('link', { property: { limitSingleRecord: true } })), 'INVALID_VALUE')
    expect(copyValue(['r1', 'r2'], field('link', { property: { refKind: 'user', limitSingleRecord: false } }))[0].value).toEqual(['r1', 'r2'])
    expectCode(() => copyValue(['a1', 'a2'], field('attachment', { property: { maxFiles: 1 } })), 'INVALID_VALUE')
    expectCode(() => paste([['Alice']], field('person')), 'INVALID_VALUE')
    expectCode(() => paste([['[{"id":"u1","name":"Alice"}]']], field('person')), 'INVALID_VALUE')
    expect(paste([['["u1","u1"]']], field('person'))[0].value).toEqual(['u1'])
  })

  it('copies links across columns only when reference sheet and kind agree (including aliases)', () => {
    const first = field('link', { property: { foreignDatasheetId: 'target', refKind: 'user' } })
    const second = field('link', { id: 'f1', property: { foreignSheetId: 'target', refKind: 'user' } })
    const args = { rows: records([[['r1'], []]]), fields: [first, second], source: cell(),
      target: { top: 0, bottom: 0, left: 0, right: 1 }, mode: 'copy' as const, canWrite: writable }
    expect(planRangeFill(args)[0].value).toEqual(['r1'])
    for (const property of [{ foreignSheetId: 'other', refKind: 'user' }, { foreignSheetId: 'target' }, {}]) {
      expectCode(() => planRangeFill({ ...args, fields: [first, { ...second, property }] }), 'INCOMPATIBLE_TYPE')
    }
    expectCode(() => planRangeFill({ ...args, fields: [field('person'), second] }), 'INCOMPATIBLE_TYPE')
  })

  it.each([
    ['multiSelect', '[1]'], ['person', '[null]'], ['person', '[[]]'],
    ['link', '[{"id":"r1"}]'], ['attachment', '{}'], ['attachment', '[true]'],
    ['rating', '1.5'], ['rating', '6'], ['duration', '-1'], ['duration', '0.5'], ['duration', '1:30'],
    ['currency', 'Infinity'], ['percent', '1e309'], ['url', 'javascript:alert(1)'],
    ['email', 'not-an-email'], ['phone', 'letters'], ['barcode', 'x'.repeat(257)], ['qrcode', 'x'.repeat(257)],
    ['location', '[]'], ['location', '{"address":"x","latitude":10}'],
    ['location', '{"address":"x","latitude":91,"longitude":0}'],
    ['location', '{"address":{},"latitude":0,"longitude":0}'],
  ] as const)('rejects malformed extended %s clipboard values', (type, value) => {
    expectCode(() => paste([[value]], field(type)), 'INVALID_VALUE')
  })

  it.each(['multiSelect', 'person', 'link', 'attachment', 'location', 'longText'] as const)('does not infer a series for %s', type => {
    expectCode(() => series([null, null], type, cell(), { top: 0, bottom: 1, left: 0, right: 0 }), 'INVALID_SERIES')
  })

  it('clones arrays and structured values independently per destination and from the source', () => {
    const source = ['u1']
    const changes = copyValue(source, field('person'))
    source.push('u2')
    expect(changes.map(change => change.value)).toEqual([['u1'], ['u1']])
    const firstPeople = changes[0].value as string[]
    firstPeople.push('u3')
    expect(changes[1].value).toEqual(['u1'])
    const location = { address: 'old', latitude: 10, longitude: 20 }
    const locations = copyValue(location, field('location'))
    location.address = 'source changed'
    const firstLocation = locations[0].value as { address: string }
    firstLocation.address = 'destination changed'
    expect(locations[1].value).toEqual({ address: 'old', latitude: 10, longitude: 20 })
  })
})


describe('range capture helpers', () => {
  it('deep-captures nested JSON objects and arrays for parent drag/request snapshots', () => {
    const source = { cells: [[{ people: ['u1'], location: { address: 'old' } }]], nullable: null }
    const expected = { cells: [[{ people: ['u1'], location: { address: 'old' } }]], nullable: null }
    const captured = cloneRangeValue(source)
    source.cells[0][0].people.push('u2')
    source.cells[0][0].location.address = 'new'
    expect(captured).toEqual(expected)
    const second = cloneRangeValue(captured) as typeof source
    second.cells[0][0].people.push('u3')
    expect(captured).toEqual(expected)
    expect(cloneRangeValue(undefined)).toBeUndefined()
  })

  it.each(['formula', 'lookup', 'rollup', 'autoNumber', 'createdTime', 'modifiedTime', 'createdBy', 'modifiedBy', 'button', 'unknown'])('prohibits %s even for an empty value', type => {
    expect(isRangeWritableFieldType(type)).toBe(false)
    expectCode(() => normalizeRangeValue(null, field(type as MetaField['type'])), 'READ_ONLY')
  })

  it('normalizes location address text and checks target rating max', () => {
    expect(paste([['Room A,B\nFloor 2']], field('location'))[0].value).toEqual({ address: 'Room A,B\nFloor 2' })
    expectCode(() => paste([['4']], field('rating', { property: { max: 3 } })), 'INVALID_VALUE')
    expect(paste([['3']], field('rating', { property: { max: 3 } }))[0].value).toBe(3)
    expectCode(() => paste([['["' + 'u'.repeat(51) + '"]']], field('person')), 'INVALID_VALUE')
    expectCode(() => copyValue(['r'.repeat(51)], field('link')), 'INVALID_VALUE')
    expectCode(() => copyValue(['a'.repeat(101)], field('attachment')), 'INVALID_VALUE')
    expect(paste([['x'.repeat(256)]], field('qrcode'))[0].value).toBe('x'.repeat(256))
  })
})
