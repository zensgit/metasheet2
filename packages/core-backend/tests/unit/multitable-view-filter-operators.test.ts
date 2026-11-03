/**
 * 2a (view filter operators) — is_any_of / is_none_of set membership on select/text fields.
 * First 2a slice: backend evaluator engine (the FE picker follows). Pure function, no DB.
 */
import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest'

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

// #6204 item 3: a `date` (date-only) filter compares the DAY each side shows — the grid's day (formatDateOnlyValue
// in the business timezone, Asia/Shanghai by default) — never the raw timestamp. A cell stored
// `2026-09-17T16:00:00.000Z` shows 2026-09-18 (00:00 北京时间; its UTC day is 09-17), so `is 2026-09-18` matches it.
describe('view filter — date-only fields compare the day the cell shows (#6204)', () => {
  const INSTANT_0918 = '2026-09-17T16:00:00.000Z' // 2026-09-18 00:00 北京时间
  const d = (cell: unknown, operator: string, value: unknown) =>
    evaluateMetaFilterCondition('date', cell, { fieldId: 'd', operator, value })

  beforeEach(() => vi.stubEnv('MULTITABLE_BUSINESS_TIMEZONE', ''))
  afterEach(() => vi.unstubAllEnvs())

  test('is / isNot: an instant matches the business day it shows on, not its UTC day', () => {
    expect(d(INSTANT_0918, 'is', '2026-09-18')).toBe(true)
    expect(d(INSTANT_0918, 'is', '2026-09-17')).toBe(false)
    expect(d(INSTANT_0918, 'isNot', '2026-09-18')).toBe(false)
    expect(d('2026-09-17T15:59:59.000Z', 'is', '2026-09-17')).toBe(true) // 23:59:59 北京时间 on 09-17
    expect(d('2026-09-18T15:00:00.000Z', 'is', '2026-09-18')).toBe(true) // 23:00 北京时间, still 09-18
    expect(d(Date.parse(INSTANT_0918), 'is', '2026-09-18')).toBe(true) // epoch-ms number: same rule
  })

  test('a day as written keeps that day, in any accepted spelling, on either side', () => {
    expect(d('2026-09-18', 'is', '2026-09-18')).toBe(true)
    expect(d('2026/9/18', 'is', '2026-09-18')).toBe(true)
    expect(d('2026年9月18日', 'is', '2026-09-18')).toBe(true)
    expect(d('2026-09-18', 'is', INSTANT_0918)).toBe(true) // an instant as the filter value: its business day
  })

  test('greater / less / between compare whole days', () => {
    expect(d(INSTANT_0918, 'less', '2026-09-18')).toBe(false) // was true: 16:00Z on 09-17 < 09-18T00:00Z
    expect(d(INSTANT_0918, 'greaterEqual', '2026-09-18')).toBe(true)
    expect(d(INSTANT_0918, 'lessEqual', '2026-09-18')).toBe(true)
    expect(d(INSTANT_0918, 'greater', '2026-09-17')).toBe(true)
    expect(d(INSTANT_0918, 'between', ['2026-09-18', '2026-09-18'])).toBe(true) // single-day range, inclusive
    expect(d('2026-09-18T15:00:00.000Z', 'between', ['2026-09-01', '2026-09-18'])).toBe(true)
    expect(d('2026-09-18T16:00:00.000Z', 'between', ['2026-09-01', '2026-09-18'])).toBe(false) // 09-19 北京时间
  })

  test('the business timezone decides: the same instant is 09-17 in New York', () => {
    vi.stubEnv('MULTITABLE_BUSINESS_TIMEZONE', 'America/New_York')
    expect(d(INSTANT_0918, 'is', '2026-09-17')).toBe(true)
    expect(d(INSTANT_0918, 'is', '2026-09-18')).toBe(false)
  })

  test('a value that names no day never matches (and an unparseable between bound stays inactive)', () => {
    expect(d('not a date', 'is', '2026-09-18')).toBe(false)
    expect(d('not a date', 'isNot', '2026-09-18')).toBe(true)
    expect(d('2026-09-18', 'is', 'whenever')).toBe(false)
    expect(d('2026-09-18', 'between', ['x', 'y'])).toBe(true)
  })

  test('number fields are untouched (still numeric)', () => {
    expect(evaluateMetaFilterCondition('number', 20260918, { fieldId: 'n', operator: 'is', value: '20260918' })).toBe(true)
  })
})
