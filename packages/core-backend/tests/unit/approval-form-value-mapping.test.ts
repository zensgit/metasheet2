/** FWB-1 slice ① — pure mapping goldens (runs in the required no-DB lane). Fail-closed all-or-nothing. */
import { describe, expect, test } from 'vitest'

import { mapApprovalFormValues, type FwbFieldMapping } from '../../src/multitable/approval-form-value-mapping'

const M = (over: Partial<FwbFieldMapping>): FwbFieldMapping => ({
  formFieldId: 'f1',
  targetFieldId: 't1',
  targetType: 'text',
  ...over,
})

describe('FWB-1 form-value mapping (pure, fail-closed)', () => {
  test('happy path: text/number/date/select all map; number strings normalize, date preserved byte-for-byte', () => {
    const r = mapApprovalFormValues(
      [
        M({ formFieldId: 'a', targetFieldId: 'ta', targetType: 'text' }),
        M({ formFieldId: 'b', targetFieldId: 'tb', targetType: 'number' }),
        M({ formFieldId: 'c', targetFieldId: 'tc', targetType: 'date' }),
        M({ formFieldId: 'e', targetFieldId: 'te', targetType: 'select', selectOptions: ['低', '中', '高'] }),
      ],
      { a: 42, b: ' 3.5 ', c: '2026-07-15', e: '高' },
    )
    expect(r).toEqual({ ok: true, values: { ta: '42', tb: 3.5, tc: '2026-07-15', te: '高' } })
  })

  test('date identity: an approved YYYY-MM-DD string is preserved byte-for-byte (no Date/toISOString round-trip, no timezone shift)', () => {
    // The contract does not reinterpret a civil date as an instant. A local-midnight
    // Date conversion can shift the day when serialized in a different timezone; this
    // byte-exact assertion pins the intended representation independently of host TZ.
    for (const value of ['2026-07-15', '2024-02-29', '2000-02-29', '1999-12-31', '2026-01-01']) {
      const r = mapApprovalFormValues([M({ targetType: 'date' })], { f1: value })
      expect(r).toEqual({ ok: true, values: { t1: value } })
    }
  })

  test('date rejects instants and non-strict shapes instead of inventing a civil date', () => {
    const cases: Array<[string, unknown]> = [
      ['epoch-ms number', Date.UTC(2026, 6, 15)],
      ['epoch-ms number (local-midnight-ish)', 1752537600000],
      ['ISO datetime string', '2026-07-15T10:00:00Z'],
      ['ISO datetime with offset', '2026-07-15T23:30:00+08:00'],
      ['Date object', new Date(Date.UTC(2026, 6, 15))],
      ['locale string', '7/15/2026'],
      ['surrounding whitespace (left)', ' 2026-07-15'],
      ['surrounding whitespace (right)', '2026-07-15 '],
      ['single-digit month/day', '2026-7-15'],
      ['year zero', '0000-01-01'],
    ]
    for (const [label, v] of cases) {
      const r = mapApprovalFormValues([M({ targetType: 'date' })], { f1: v })
      expect(r.ok, label).toBe(false)
      if (!r.ok) expect(r.errors[0].code, label).toBe('not_a_date')
    }
  })

  test('ALL-OR-NOTHING: one bad mapping rejects the whole action with per-mapping codes', () => {
    const r = mapApprovalFormValues(
      [
        M({ formFieldId: 'good', targetFieldId: 'tg', targetType: 'text' }),
        M({ formFieldId: 'bad', targetFieldId: 'tb', targetType: 'number' }),
      ],
      { good: 'ok', bad: 'NaN-ish' },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors).toEqual([{ formFieldId: 'bad', targetFieldId: 'tb', code: 'not_a_number' }])
  })

  test('fail-closed vocabulary: select outside options / options missing / unsupported type / object-as-text all reject', () => {
    const cases: Array<[FwbFieldMapping, unknown, string]> = [
      [M({ targetType: 'select', selectOptions: ['a'] }), 'z', 'select_value_not_in_options'],
      [M({ targetType: 'select' }), 'a', 'select_options_missing'],
      [M({ targetType: 'formula' as never }), 'x', 'unsupported_target_type'],
      [M({ targetType: 'text' }), { nested: true }, 'not_text'],
      [M({ targetType: 'date' }), '15/07/2026', 'not_a_date'],
    ]
    for (const [m, v, code] of cases) {
      const r = mapApprovalFormValues([m], { f1: v })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors[0].code).toBe(code)
    }
  })

  test('rejects calendar-invalid ISO dates instead of persisting invented dates', () => {
    for (const value of ['2026-02-29', '2026-02-31', '2026-04-31', '2026-13-01', '2026-00-10']) {
      const r = mapApprovalFormValues([M({ targetType: 'date' })], { f1: value })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors[0].code).toBe('not_a_date')
    }

    expect(mapApprovalFormValues([M({ targetType: 'date' })], { f1: '2024-02-29' })).toEqual({
      ok: true,
      values: { t1: '2024-02-29' },
    })
  })

  test('missing/blank form values are errors (never silently skipped)', () => {
    for (const v of [undefined, null, '   ']) {
      const r = mapApprovalFormValues([M({})], { f1: v })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors[0].code).toBe('missing_required_value')
    }
  })

  test('numbers fail closed on unsafe integer precision and target decimal scale', () => {
    const unsafe = mapApprovalFormValues([M({ targetType: 'number' })], { f1: 9007199254740993 })
    expect(unsafe.ok).toBe(false)
    if (!unsafe.ok) expect(unsafe.errors[0].code).toBe('number_not_lossless')

    const tooPrecise = mapApprovalFormValues([M({ targetType: 'number', numberPrecision: 2 })], { f1: '12.345' })
    expect(tooPrecise.ok).toBe(false)
    if (!tooPrecise.ok) expect(tooPrecise.errors[0].code).toBe('number_precision_exceeded')

    expect(mapApprovalFormValues([M({ targetType: 'number', numberPrecision: 2 })], { f1: '12.340' }))
      .toEqual({ ok: true, values: { t1: 12.34 } })
  })
})
