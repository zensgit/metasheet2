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
