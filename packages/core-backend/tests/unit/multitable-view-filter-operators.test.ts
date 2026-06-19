/**
 * 2a (view filter operators) — is_any_of / is_none_of set membership on select/text fields.
 * First 2a slice: backend evaluator engine (the FE picker follows). Pure function, no DB.
 */
import { describe, test, expect } from 'vitest'

import { evaluateMetaFilterCondition } from '../../src/routes/univer-meta'

// FE sends camelCase operators ('isNot', 'doesNotContain', …); the evaluator lowercases. Use the same.
const sel = (cell: unknown, operator: string, value: unknown) =>
  evaluateMetaFilterCondition('select', cell, { fieldId: 'f', operator, value })

describe('view filter — isAnyOf / isNoneOf (2a)', () => {
  test('isAnyOf matches when the cell value is in the array', () => {
    expect(sel('open', 'isAnyOf', ['open', 'closed'])).toBe(true)
    expect(sel('archived', 'isAnyOf', ['open', 'closed'])).toBe(false)
  })

  test('isAnyOf is case/whitespace-insensitive (mirrors is/contains normalization)', () => {
    expect(sel('  Open ', 'isAnyOf', ['open'])).toBe(true)
    expect(sel('open', 'isAnyOf', ['OPEN', 'CLOSED'])).toBe(true)
  })

  test('isNoneOf is the negation', () => {
    expect(sel('open', 'isNoneOf', ['open', 'closed'])).toBe(false)
    expect(sel('archived', 'isNoneOf', ['open', 'closed'])).toBe(true)
  })

  test('empty array = inactive filter (match all) — mirrors empty contains', () => {
    expect(sel('anything', 'isAnyOf', [])).toBe(true)
    expect(sel('anything', 'isNoneOf', [])).toBe(true)
  })

  test('non-array value never throws (treated as inactive)', () => {
    expect(sel('open', 'isAnyOf', 'open')).toBe(true)
    expect(sel('open', 'isNoneOf', undefined)).toBe(true)
  })
})

describe('view filter — between (2a)', () => {
  const num = (cell: unknown, value: unknown) =>
    evaluateMetaFilterCondition('number', cell, { fieldId: 'n', operator: 'between', value })
  const date = (cell: unknown, value: unknown) =>
    evaluateMetaFilterCondition('date', cell, { fieldId: 'd', operator: 'between', value })

  test('numeric between is inclusive', () => {
    expect(num(15, [10, 20])).toBe(true)
    expect(num(10, [10, 20])).toBe(true) // lower bound inclusive
    expect(num(20, [10, 20])).toBe(true) // upper bound inclusive
    expect(num(5, [10, 20])).toBe(false)
    expect(num(25, [10, 20])).toBe(false)
  })

  test('reversed bounds tolerated', () => {
    expect(num(15, [20, 10])).toBe(true)
  })

  test('incomplete / unparseable / non-array bounds = inactive (match all)', () => {
    expect(num(999, [10])).toBe(true) // one bound → inactive
    expect(num(999, [])).toBe(true)
    expect(num(999, 'x')).toBe(true) // non-array → inactive
    expect(num(999, ['x', 'y'])).toBe(true) // unparseable bounds → inactive
  })

  test('null cell never matches a real range', () => {
    expect(num(null, [10, 20])).toBe(false)
  })

  test('date between (epoch comparison)', () => {
    expect(date('2026-02-15', ['2026-02-01', '2026-02-28'])).toBe(true)
    expect(date('2026-03-15', ['2026-02-01', '2026-02-28'])).toBe(false)
  })
})
