import { describe, expect, it, vi } from 'vitest'
import {
  BATCH1_FIELD_TYPES,
  coerceBatch1Value,
  validateDateValue,
  validateDateTimeValue,
} from '../../src/multitable/field-codecs'
import { assertNoNulInRecordValue, serializeRecordData } from '../../src/multitable/field-validation'
import {
  createRecord,
  getRecord,
  patchRecord,
  MultitableRecordValidationError,
} from '../../src/multitable/records'
import { buildXlsxImportRecords } from '../../src/multitable/xlsx-service'

const invalidDates = [
  'not-a-date', '2026-02-29', '2024-02-30', '1900-02-29', '2100-02-29',
  '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '2026-01-32',
  '2026-09/24', '2026-09-24junk', '20260924', '2026',
  '2026-02-30T00:00:00Z', '2026-09-24T24:00:00Z', '2026-09-24T09:60:00Z',
  '2026-09-24T09:00:60Z', '2026-09-24T09:00:00+99:99',
  '２０２６年２月２９日', '2026/2/29 9:30', 'Fri, 30 Feb 2024 00:00:00 GMT',
  123, false, {}, [],
]
const validDates = [
  null, undefined, '', '   ', '2024-02-29', '2000-02-29', '2026-09-24',
  '2026/9/24', '2026.9.24', '2026年9月24日', '２０２６－０９－２４',
  '2026-09-24 09:30', '2026-09-24T09:30:00.123Z', '2026-09-24T09:30:00+08:00',
  '2026-09-24T09:30:00-0530', '2026-09-24 09:30:00+00',
]

describe('date write coercion', () => {
  it.each(invalidDates.map((value) => [value]))('rejects an invalid calendar value: %j', (value) => {
    expect(() => validateDateValue(value, 'day')).toThrow(MultitableRecordValidationError)
    expect(() => coerceBatch1Value('date', undefined, 'day', value)).toThrow(MultitableRecordValidationError)
  })

  it.each(validDates)('preserves a supported value without timezone conversion: %j', (value) => {
    expect(validateDateValue(value, 'day')).toBe(value)
    expect(coerceBatch1Value('date', undefined, 'day', value)).toBe(value)
  })

  it('does not widen the retype allowlist or change dateTime coercion', () => {
    expect(BATCH1_FIELD_TYPES.has('date')).toBe(false)
    expect(coerceBatch1Value('dateTime', { timezone: 'Asia/Tokyo' }, 'when', '2026-09-24 09:00'))
      .toBe('2026-09-24T00:00:00.000Z')
    expect(validateDateTimeValue('2026-09-24T09:00:00+08:00', 'when'))
      .toBe('2026-09-24T01:00:00.000Z')
    expect(validateDateTimeValue('', 'when')).toBeNull()
    expect(() => validateDateTimeValue('2026-02-30', 'when')).toThrow()
  })

  it('validates the strings produced by the XLSX import record builder', () => {
    const { records } = buildXlsxImportRecords({ rows: [['2024-02-29'], ['2026-02-29'], ['']] }, { 0: 'day' })
    expect(coerceBatch1Value('date', undefined, 'day', records[0].day)).toBe('2024-02-29')
    expect(() => coerceBatch1Value('date', undefined, 'day', records[1].day)).toThrow(MultitableRecordValidationError)
    expect(coerceBatch1Value('date', undefined, 'day', records[2].day)).toBe('')
  })
})

const nulData = [
  { title: 'before\u0000after' },
  { payload: { nested: ['safe', { value: '\u0000' }] } },
  { payload: { nested: [{ ['key\u0000']: 'safe' }] } },
  { ['title\u0000']: 'safe' },
  { rich: '<p>before\u0000after</p>' },
  { rich: { type: 'doc', content: [{ type: 'text', text: 'a\u0000b' }] } },
]

describe('record JSON NUL guard', () => {
  it.each(nulData)('rejects nested values and property keys without stripping: %j', (data) => {
    const original = JSON.stringify(data)
    expect(() => assertNoNulInRecordValue(data)).toThrow(MultitableRecordValidationError)
    expect(() => serializeRecordData(data)).toThrow(MultitableRecordValidationError)
    expect(JSON.stringify(data)).toBe(original)
  })

  it('checks the serialized representation, including toJSON values and keys', () => {
    expect(() => serializeRecordData({ payload: { toJSON: () => '\u0000' } })).toThrow(MultitableRecordValidationError)
    expect(() => serializeRecordData({ payload: { toJSON: () => ({ ['bad\u0000']: 'ok' }) } }))
      .toThrow(MultitableRecordValidationError)
    expect(serializeRecordData({ when: new Date('2024-02-29T00:00:00Z') }))
      .toBe('{"when":"2024-02-29T00:00:00.000Z"}')
  })

  it('preserves safe strings, escaped literal text, controls other than NUL, and nested JSON', () => {
    const data = { title: '中文🙂\\u0000\n\r\t', payload: { ['key\\u0000']: ['safe', 0, false, null] } }
    expect(serializeRecordData(data)).toBe(JSON.stringify(data))
    expect(() => assertNoNulInRecordValue(data)).not.toThrow()
  })
})

function createFakeQuery(existingData: Record<string, unknown> = { day: '2024-02-29', title: 'before' }) {
  const fields = [
    { id: 'day', type: 'date' }, { id: 'title', type: 'string' },
    { id: 'payload', type: 'json' }, { id: 'rich', type: 'longText', property: { rich: true } },
  ].map((field) => ({ name: field.id, property: {}, ...field }))
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (sql.includes('FROM meta_sheets')) return { rows: [{ id: 'sheet', base_id: 'base', name: 'Synthetic' }] }
    if (sql.includes('FROM meta_fields')) return { rows: fields }
    if (sql.includes('FROM meta_records')) {
      return { rows: [{ id: 'record', sheet_id: 'sheet', data: existingData, version: 1, locked: false }] }
    }
    if (/^\s*(INSERT INTO|UPDATE) meta_records\b/.test(sql)) return { rows: [{ version: 2 }] }
    if (/^\s*INSERT INTO meta_record_revisions\b/.test(sql)) return { rows: [] }
    throw new Error(`Unexpected synthetic query: ${sql}`)
  })
  const writes = () => query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql))
  return { query, writes }
}

describe.each(['create', 'patch'] as const)('SDK %s validates before record writes', (operation) => {
  async function write(query: ReturnType<typeof createFakeQuery>['query'], data: Record<string, unknown>) {
    return operation === 'create'
      ? createRecord({ query, sheetId: 'sheet', data })
      : patchRecord({ query, sheetId: 'sheet', recordId: 'record', changes: data })
  }

  it.each(invalidDates.map((value) => [value]))('refuses an invalid date before any mutation: %j', async (day) => {
    const { query, writes } = createFakeQuery()
    await expect(write(query, { day })).rejects.toBeInstanceOf(MultitableRecordValidationError)
    expect(writes()).toEqual([])
  })

  it.each(nulData)('refuses NUL before any query or sanitization: %j', async (data) => {
    const { query, writes } = createFakeQuery()
    await expect(write(query, data)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(query).not.toHaveBeenCalled()
    expect(writes()).toEqual([])
  })

  it.each(['2024-02-29', '2000-02-29', '', null])('writes valid or empty dates unchanged: %j', async (day) => {
    const { query, writes } = createFakeQuery()
    const result = await write(query, { day, title: 'safe\\u0000\n中文' })
    expect(result.data.day).toBe(day)
    expect(result.data.title).toBe('safe\\u0000\n中文')
    expect(writes()).toHaveLength(2)
    const statement = writes()[0]
    const serialized = statement[1]?.[operation === 'create' ? 2 : 0]
    expect(JSON.parse(String(serialized))).toEqual(result.data)
  })
})

it('keeps dirty legacy dates readable and permits unrelated patches', async () => {
  const { query } = createFakeQuery({ day: 'legacy-not-a-date', title: 'before' })
  const record = await getRecord({ query, sheetId: 'sheet', recordId: 'record' })
  expect(record.data.day).toBe('legacy-not-a-date')
  const patched = await patchRecord({ query, sheetId: 'sheet', recordId: 'record', changes: { title: 'after' } })
  expect(patched.data).toEqual({ day: 'legacy-not-a-date', title: 'after' })
})
