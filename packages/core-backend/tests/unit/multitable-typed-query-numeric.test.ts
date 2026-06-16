/**
 * Slice 1 (typed query polish) unit matrix — proves currency/percent/rating are
 * treated as NUMERIC (not text) by the shared predicate + the two in-memory query
 * helpers, and that string-like types (url/email/phone) are unchanged.
 *
 * Pure functions, no DB. The real-`/view` wire proof lives in the DB-gated
 * integration test (multitable-typed-query-numeric.int.test.ts) — both bars per
 * docs/development/multitable-typed-query-polish-design-20260603.md §7.
 */
import { describe, expect, it } from 'vitest'

import {
  compareMetaSortValue,
  evaluateMetaFilterCondition,
  isNumericQueryFieldType,
} from '../../src/routes/univer-meta'

const cond = (operator: string, value?: unknown) => ({ fieldId: 'f', operator, value })
const sortAsc = (type: any, arr: unknown[]) => [...arr].sort((a, b) => compareMetaSortValue(type, a, b, false))

describe('isNumericQueryFieldType', () => {
  it('is true for number/currency/percent/rating/duration', () => {
    for (const t of ['number', 'currency', 'percent', 'rating', 'duration']) {
      expect(isNumericQueryFieldType(t)).toBe(true)
    }
  })
  it('is false for text/date/boolean/select and url/email/phone', () => {
    for (const t of ['string', 'longText', 'url', 'email', 'phone', 'date', 'dateTime', 'boolean', 'select', 'link']) {
      expect(isNumericQueryFieldType(t)).toBe(false)
    }
  })
  it('is false for rollup (callers pre-normalize rollup → number; predicate need not list it)', () => {
    expect(isNumericQueryFieldType('rollup')).toBe(false)
  })
})

describe('compareMetaSortValue — numeric reclassification', () => {
  // The exact case localeCompare(numeric:true) gets wrong: "1.5" vs "1.25" compares
  // the fractional digit-runs 5 vs 25 → "1.5" < "1.25". And negatives ("-5") were punctuation.
  it('currency sorts by numeric value incl. decimals + negatives (was lexicographic)', () => {
    expect(sortAsc('currency', [10, 2, 1.5, 1.25, -5])).toEqual([-5, 1.25, 1.5, 2, 10])
  })
  it('currency sorts descending', () => {
    expect([...[10, 2, 1.5, 1.25, -5]].sort((a, b) => compareMetaSortValue('currency', a, b, true)))
      .toEqual([10, 2, 1.5, 1.25, -5])
  })
  it('percent sorts by numeric value (0.5 > 0.25, not the lexicographic reverse)', () => {
    expect(sortAsc('percent', [0.5, 0.25, 0.05, 1])).toEqual([0.05, 0.25, 0.5, 1])
  })
  it('rating sorts numerically (was already fine for integers; still correct)', () => {
    expect(sortAsc('rating', [3, 1, 5, 2])).toEqual([1, 2, 3, 5])
  })
  it('duration sorts by its seconds value (scatter guard — numeric, not lexicographic)', () => {
    // 600s(10m) < 5400s(1h30) < 90000s(25h) — lexicographic would give 5400, 600, 90000.
    expect(sortAsc('duration', [5400, 600, 90000])).toEqual([600, 5400, 90000])
  })
  it('currency tolerates string-stored numbers (legacy/mixed storage)', () => {
    expect(compareMetaSortValue('currency', '12.5', 2, false)).toBeGreaterThan(0) // 12.5 after 2
  })
  it('nulls sink last regardless of direction', () => {
    expect(sortAsc('currency', [5, null, 2])).toEqual([2, 5, null])
  })
  // regressions: unchanged behavior for the existing branches
  it('number unchanged (numeric)', () => {
    expect(sortAsc('number', [10, 2, 1.5])).toEqual([1.5, 2, 10])
  })
  it('string unchanged (localeCompare numeric collation)', () => {
    expect(sortAsc('string', ['10', '2', '1'])).toEqual(['1', '2', '10'])
  })
  it('date unchanged (epoch)', () => {
    expect(sortAsc('date', ['2026-03-01', '2026-01-15', '2025-12-31']))
      .toEqual(['2025-12-31', '2026-01-15', '2026-03-01'])
  })
})

describe('evaluateMetaFilterCondition — numeric reclassification', () => {
  it('currency range ops compare numerically (were silent no-ops via the string branch)', () => {
    expect(evaluateMetaFilterCondition('currency', 2, cond('greater', 1.5))).toBe(true)
    expect(evaluateMetaFilterCondition('currency', 1.25, cond('greater', 1.5))).toBe(false)
    expect(evaluateMetaFilterCondition('currency', 1.5, cond('greater', 1.5))).toBe(false) // strict
    expect(evaluateMetaFilterCondition('currency', 1.5, cond('greaterEqual', 1.5))).toBe(true)
    expect(evaluateMetaFilterCondition('currency', 1.25, cond('less', 1.5))).toBe(true)
    expect(evaluateMetaFilterCondition('currency', 2, cond('lessEqual', 2))).toBe(true)
  })
  it('currency equality is numeric (100.5 === "100.50", which string equality missed)', () => {
    expect(evaluateMetaFilterCondition('currency', 100.5, cond('is', '100.50'))).toBe(true)
    expect(evaluateMetaFilterCondition('currency', 100.5, cond('isNot', '100.50'))).toBe(false)
  })
  it('rating range ops now work (rating-specific gap: sort was fine, range was a no-op)', () => {
    expect(evaluateMetaFilterCondition('rating', 3, cond('greaterEqual', 3))).toBe(true)
    expect(evaluateMetaFilterCondition('rating', 2, cond('greaterEqual', 3))).toBe(false)
  })
  it('percent range ops compare numerically', () => {
    expect(evaluateMetaFilterCondition('percent', 0.5, cond('greater', 0.25))).toBe(true)
    expect(evaluateMetaFilterCondition('percent', 0.05, cond('greater', 0.25))).toBe(false)
  })
  it('duration range ops compare on raw seconds (scatter guard)', () => {
    expect(evaluateMetaFilterCondition('duration', 5400, cond('greaterEqual', 3600))).toBe(true)
    expect(evaluateMetaFilterCondition('duration', 600, cond('greaterEqual', 3600))).toBe(false)
    expect(evaluateMetaFilterCondition('duration', 3600, cond('less', 3600))).toBe(false)
  })
  it('isEmpty/isNotEmpty unchanged for numeric types', () => {
    expect(evaluateMetaFilterCondition('currency', null, cond('isEmpty'))).toBe(true)
    expect(evaluateMetaFilterCondition('currency', 0, cond('isNotEmpty'))).toBe(true)
  })
  it('ACCEPTED reclassification effect: a `contains` filter persisted on currency before Slice 1 now no-ops (shows all)', () => {
    // The numeric branch has no text-operator case → catch-all returns true. The operator menu no
    // longer offers `contains` for currency/percent/rating, so this only affects pre-Slice-1 views.
    expect(evaluateMetaFilterCondition('currency', 7, cond('contains', '5'))).toBe(true)
  })

  // url/email/phone: deliberately NOT numeric — they keep the string operator family.
  it('url/email/phone stay string-typed: contains + equality work', () => {
    expect(evaluateMetaFilterCondition('url', 'https://Example.com/x', cond('contains', 'example'))).toBe(true)
    expect(evaluateMetaFilterCondition('email', 'a@b.com', cond('is', 'A@B.com'))).toBe(true) // case-insensitive
    expect(evaluateMetaFilterCondition('phone', '+86 138', cond('contains', '138'))).toBe(true)
  })
  it('url range op is an inert no-op (string branch default) — not meaningful, not numeric', () => {
    // documents the intended boundary: a range operator on a text field returns true (no filtering),
    // exactly as before; url/email/phone are intentionally excluded from isNumericQueryFieldType.
    expect(evaluateMetaFilterCondition('url', 'https://a.com', cond('greater', 'https://b.com'))).toBe(true)
  })

  // regressions
  it('number range ops unchanged', () => {
    expect(evaluateMetaFilterCondition('number', 5, cond('greater', 3))).toBe(true)
    expect(evaluateMetaFilterCondition('number', 2, cond('greater', 3))).toBe(false)
  })
  it('string contains unchanged', () => {
    expect(evaluateMetaFilterCondition('string', 'hello world', cond('contains', 'world'))).toBe(true)
  })
})
