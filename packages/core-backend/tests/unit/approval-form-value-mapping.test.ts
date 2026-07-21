/**
 * FWB-1 slice ① — pure mapping goldens (runs in the required no-DB lane). Fail-closed all-or-nothing.
 *
 * MUTATION NOTES (discriminating assertions — each pins a mutant that a weaker test would pass):
 *   - number output is a STRING ('42', not 42): kills the mutant that returns JS Numbers (D7 float-loss).
 *   - '1e3'/'1E-2' reject: kills a mutant regex that admits exponent notation.
 *   - '.5'/'5.'/'+5'/''/'  ' reject: kills grammar mutants admitting partial lexemes.
 *   - '007.50' → '7.5', '-0.00' → '0': kills mutants that skip leading-zero or signed-zero canonicalization
 *     (two DISTINCT mutants — one test each).
 *   - '12.340' under precision 2 → '12.34' passes while '12.345' rejects: kills mutants measuring scale
 *     before trailing-zero stripping, and mutants that round instead of rejecting (Q5).
 *   - '9007199254740993' (string) passes EXACTLY while 9007199254740993 (number) rejects: kills the mutant
 *     that rejects long decimal STRING lexemes (exact arbitrary precision — they never pass through
 *     Number) AND the mutant that trusts unsafe JS integers.
 *   - 9007199254740991.1 (number) rejects: JSON.parse rounds it to the SAFE integer 9007199254740991 —
 *     the safe-integer check alone cannot see the destroyed fraction; kills the mutant that drops the
 *     ≤15-significant-digit envelope on numeric inputs (fabricated digits would be written).
 *   - date rejects epoch-ms numbers (not_a_date): kills the mutant that keeps the deleted epoch branch
 *     (D8: no epoch input, no timezone conversion).
 */
import { describe, expect, test } from 'vitest'

import { mapApprovalFormValues, type FwbFieldMapping } from '../../src/multitable/approval-form-value-mapping'

const M = (over: Partial<FwbFieldMapping>): FwbFieldMapping => ({
  formFieldId: 'f1',
  targetFieldId: 't1',
  targetType: 'text',
  ...over,
})

const rejectCode = (m: FwbFieldMapping, v: unknown): string => {
  const r = mapApprovalFormValues([m], { f1: v })
  expect(r.ok).toBe(false)
  if (!r.ok) return r.errors[0].code
  throw new Error('unreachable')
}

describe('FWB-1 form-value mapping (pure, fail-closed)', () => {
  test('happy path: text/number/date/select all map; numbers normalize to CANONICAL DECIMAL STRINGS', () => {
    const r = mapApprovalFormValues(
      [
        M({ formFieldId: 'a', targetFieldId: 'ta', targetType: 'text' }),
        M({ formFieldId: 'b', targetFieldId: 'tb', targetType: 'number' }),
        M({ formFieldId: 'c', targetFieldId: 'tc', targetType: 'date' }),
        M({ formFieldId: 'd', targetFieldId: 'td', targetType: 'number' }),
        M({ formFieldId: 'e', targetFieldId: 'te', targetType: 'select', selectOptions: ['低', '中', '高'] }),
      ],
      { a: 42, b: ' 3.5 ', c: '2026-07-15', d: 1000, e: '高' },
    )
    expect(r).toEqual({ ok: true, values: { ta: '42', tb: '3.5', tc: '2026-07-15', td: '1000', te: '高' } })
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
      expect(rejectCode(m, v)).toBe(code)
    }
  })

  test('rejects calendar-invalid ISO dates instead of persisting invented dates', () => {
    for (const value of ['2026-02-29', '2026-02-31', '2026-04-31', '2026-13-01', '2026-00-10']) {
      expect(rejectCode(M({ targetType: 'date' }), value)).toBe('not_a_date')
    }

    expect(mapApprovalFormValues([M({ targetType: 'date' })], { f1: '2024-02-29' })).toEqual({
      ok: true,
      values: { t1: '2024-02-29' },
    })
  })

  test('date accepts ONLY explicit calendar-date strings — epoch-ms numbers and datetimes reject (lock D8)', () => {
    // epoch-ms number input: the deleted coercion path — a number must NEVER become a date.
    expect(rejectCode(M({ targetType: 'date' }), Date.UTC(2026, 6, 15))).toBe('not_a_date')
    expect(rejectCode(M({ targetType: 'date' }), 0)).toBe('not_a_date')
    // datetime / timezoned strings are not calendar-date literals.
    expect(rejectCode(M({ targetType: 'date' }), '2026-07-15T00:00:00Z')).toBe('not_a_date')
    expect(rejectCode(M({ targetType: 'date' }), '2026-07-15+08:00')).toBe('not_a_date')
  })

  test('missing/blank form values are errors (never silently skipped)', () => {
    for (const v of [undefined, null, '   ']) {
      expect(rejectCode(M({}), v)).toBe('missing_required_value')
    }
  })

  test('number canonicalization: leading zeros, trailing zeros, signed zero (lock D7)', () => {
    const cases: Array<[string, string]> = [
      ['007.50', '7.5'],
      ['000', '0'],
      ['-0', '0'],
      ['-0.00', '0'],
      ['0.0', '0'],
      ['3.500', '3.5'],
      ['10.000', '10'],
      ['-001.2500', '-1.25'],
      ['0.5', '0.5'],
      ['-42', '-42'],
    ]
    for (const [input, canonical] of cases) {
      expect(mapApprovalFormValues([M({ targetType: 'number' })], { f1: input }))
        .toEqual({ ok: true, values: { t1: canonical } })
    }
  })

  test('number STRING lexemes are EXACT at any scale — arbitrary precision, never through Number', () => {
    // 17 significant digits exceed the numeric-input envelope; as a STRING lexeme it is exact decimal
    // data and must round-trip byte-for-byte (the envelope bounds only JSON.parse-rounded numerics).
    expect(mapApprovalFormValues([M({ targetType: 'number' })], { f1: '9007199254740993' }))
      .toEqual({ ok: true, values: { t1: '9007199254740993' } })
    expect(mapApprovalFormValues([M({ targetType: 'number' })], { f1: '0.123456789012345678901234567890' }))
      .toEqual({ ok: true, values: { t1: '0.12345678901234567890123456789' } })
  })

  test('number rejects JSON numeric inputs whose provenance cannot be lossless (>15 significant digits)', () => {
    // REGRESSION (exact counterexample): the literal 9007199254740991.1 rounds to the SAFE integer
    // 9007199254740991 at JSON parse — the .1 fraction is destroyed before this function runs and the
    // safe-integer check alone PASSES it. The significant-digit envelope is what rejects it; writing it
    // would fabricate digits. (Same shape: 9007199254740990.5 → 9007199254740990.)
    expect(rejectCode(M({ targetType: 'number' }), 9007199254740991.1)).toBe('number_not_lossless')
    expect(rejectCode(M({ targetType: 'number' }), 9007199254740990.5)).toBe('number_not_lossless')
    expect(rejectCode(M({ targetType: 'number' }), 1234567890123456.7)).toBe('number_not_lossless')
    // boundary: exactly 15 significant digits stays inside the reliably round-trippable envelope.
    expect(mapApprovalFormValues([M({ targetType: 'number' })], { f1: 123456789012345 }))
      .toEqual({ ok: true, values: { t1: '123456789012345' } })
    expect(mapApprovalFormValues([M({ targetType: 'number' })], { f1: 0.123456789012345 }))
      .toEqual({ ok: true, values: { t1: '0.123456789012345' } })
  })

  test('number rejects exponent notation, NaN/Infinity and malformed lexemes (never coerced)', () => {
    const notANumber: unknown[] = [
      '1e3', '1E-2', '1e+3', // exponent notation
      'NaN', 'Infinity', '-Infinity', 'inf',
      '.5', '5.', '+5', '--5', '0x10', '0b101', '1_000', '1,000', '1.2.3', 'abc', '-',
      true, {}, [], Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
    ]
    for (const v of notANumber) {
      expect(rejectCode(M({ targetType: 'number' }), v)).toBe('not_a_number')
    }
  })

  test('number rejects unsafe JS-number inputs (already lossy / non-canonical), not_a_number vs not_lossless', () => {
    // unsafe integer: JSON parse already destroyed the source lexeme — writing it would fabricate digits.
    expect(rejectCode(M({ targetType: 'number' }), 9007199254740993)).toBe('number_not_lossless')
    // exponent-form String() output: no canonical fixed-point form here.
    expect(rejectCode(M({ targetType: 'number' }), 1e21)).toBe('number_not_lossless')
    expect(rejectCode(M({ targetType: 'number' }), 1e-7)).toBe('number_not_lossless')
    // safe finite JS numbers DO map (the JSON-snapshot happy path), canonicalized.
    expect(mapApprovalFormValues([M({ targetType: 'number' })], { f1: 12.340 }))
      .toEqual({ ok: true, values: { t1: '12.34' } })
  })

  test('numbers fail closed on target decimal scale — excess REAL scale rejects, never rounds (§11 Q5)', () => {
    expect(rejectCode(M({ targetType: 'number', numberPrecision: 2 }), '12.345')).toBe('number_precision_exceeded')
    expect(rejectCode(M({ targetType: 'number', numberPrecision: 0 }), '0.5')).toBe('number_precision_exceeded')
    // trailing zeros carry no information: scale is measured AFTER canonicalization.
    expect(mapApprovalFormValues([M({ targetType: 'number', numberPrecision: 2 })], { f1: '12.340' }))
      .toEqual({ ok: true, values: { t1: '12.34' } })
    expect(mapApprovalFormValues([M({ targetType: 'number', numberPrecision: 0 })], { f1: '5.000' }))
      .toEqual({ ok: true, values: { t1: '5' } })
  })

  test('errors stay values-free: rejection payloads carry identifiers and codes only', () => {
    const r = mapApprovalFormValues([M({ targetType: 'number' })], { f1: 'secret-amount-1e9' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(JSON.stringify(r.errors)).not.toContain('secret-amount')
      expect(r.errors[0]).toEqual({ formFieldId: 'f1', targetFieldId: 't1', code: 'not_a_number' })
    }
  })
})
