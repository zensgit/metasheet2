/**
 * 客户反馈 2026-09-24 #4c — view filters on dateTime compare INSTANTS (PR #6083 review S2).
 *
 * Before: dateTime fell into the string branch — `is` compared the stored ISO text with the typed value
 * (never equal) and greater/less hit the catch-all `return true` (every row matched). Now a zone-less filter
 * value is a business wall clock (MULTITABLE_BUSINESS_TIMEZONE, default Asia/Shanghai), an absolute value
 * keeps its instant, and equality is at MINUTE precision (the displayed `HH:mm`).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { evaluateMetaFilterCondition } from '../../src/routes/univer-meta'

const ENV_KEY = 'MULTITABLE_BUSINESS_TIMEZONE'
const STORED = '2026-09-24T01:00:00.000Z' // 09:00 Beijing
const dt = (cell: unknown, operator: string, value: unknown) =>
  evaluateMetaFilterCondition('dateTime', cell, { fieldId: 'f', operator, value })

describe('view filter — dateTime (business wall clock, minute precision)', () => {
  let previous: string | undefined
  beforeEach(() => { previous = process.env[ENV_KEY]; delete process.env[ENV_KEY] })
  afterEach(() => { if (previous === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = previous })

  test('filter value `2026-09-24 09:00` matches a record stored as 01:00Z (Asia/Shanghai)', () => {
    expect(dt(STORED, 'is', '2026-09-24 09:00')).toBe(true)
    expect(dt(STORED, 'is', '2026-09-24T09:00')).toBe(true)
    expect(dt(STORED, 'is', '2026年9月24日 9:00')).toBe(true)
    expect(dt(STORED, 'is', '2026-09-24 09:01')).toBe(false)
    expect(dt(STORED, 'is', '2026-09-24 01:00')).toBe(false) // the raw UTC clock is NOT what the user sees
    expect(dt(STORED, 'isNot', '2026-09-24 09:00')).toBe(false)
    expect(dt(STORED, 'isNot', '2026-09-24 09:01')).toBe(true)
  })

  test('equality is at minute precision — a cell stored with seconds `is` the minute the grid shows', () => {
    expect(dt('2026-09-24T01:00:30.000Z', 'is', '2026-09-24 09:00')).toBe(true)
    expect(dt('2026-09-24T01:00:59.999Z', 'is', '2026-09-24 09:00')).toBe(true)
    expect(dt('2026-09-24T01:01:00.000Z', 'is', '2026-09-24 09:00')).toBe(false)
    // …and greater/less do not see a sub-minute difference either (consistent with what is displayed).
    expect(dt('2026-09-24T01:00:30.000Z', 'greater', '2026-09-24 09:00')).toBe(false)
    expect(dt('2026-09-24T01:00:30.000Z', 'greaterEqual', '2026-09-24 09:00')).toBe(true)
  })

  test('greater / less and their variants order by instant (they used to hit the match-all catch-all)', () => {
    expect(dt(STORED, 'greater', '2026-09-24 08:59')).toBe(true)
    expect(dt(STORED, 'greater', '2026-09-24 09:00')).toBe(false)
    expect(dt(STORED, 'isGreater', '2026-09-23 23:00')).toBe(true)
    expect(dt(STORED, 'greaterEqual', '2026-09-24 09:00')).toBe(true)
    expect(dt(STORED, 'less', '2026-09-24 09:01')).toBe(true)
    expect(dt(STORED, 'less', '2026-09-24 09:00')).toBe(false)
    expect(dt(STORED, 'isLess', '2026-09-25 00:00')).toBe(true)
    expect(dt(STORED, 'lessEqual', '2026-09-24 09:00')).toBe(true)
    expect(dt(STORED, 'lessEqual', '2026-09-24 08:59')).toBe(false)
  })

  test('an absolute filter value keeps its instant regardless of the business zone', () => {
    expect(dt(STORED, 'is', '2026-09-24T01:00:00.000Z')).toBe(true)
    expect(dt(STORED, 'is', '2026-09-24T09:00:00+08:00')).toBe(true)
    expect(dt(STORED, 'is', '2026-09-23T21:00:00-04:00')).toBe(true)
    process.env[ENV_KEY] = 'America/New_York'
    expect(dt(STORED, 'is', '2026-09-24T01:00:00.000Z')).toBe(true)
  })

  test('the business zone env changes what a zone-less filter value means', () => {
    process.env[ENV_KEY] = 'America/New_York'
    expect(dt(STORED, 'is', '2026-09-23 21:00')).toBe(true)
    expect(dt(STORED, 'is', '2026-09-24 09:00')).toBe(false)
    process.env[ENV_KEY] = 'Asia/Kathmandu'
    expect(dt(STORED, 'is', '2026-09-24 06:45')).toBe(true)
  })

  test('between is inclusive on minute keys; incomplete / unparseable bounds = inactive; empty cell never in range', () => {
    expect(dt(STORED, 'between', ['2026-09-24 08:00', '2026-09-24 10:00'])).toBe(true)
    expect(dt(STORED, 'between', ['2026-09-24 10:00', '2026-09-24 08:00'])).toBe(true) // reversed tolerated
    expect(dt(STORED, 'between', ['2026-09-24 09:00', '2026-09-24 09:00'])).toBe(true)
    expect(dt(STORED, 'between', ['2026-09-24 09:01', '2026-09-24 10:00'])).toBe(false)
    expect(dt(STORED, 'between', ['2026-09-24 08:00'])).toBe(true)
    expect(dt(STORED, 'between', ['junk', '2026-09-24 10:00'])).toBe(true)
    expect(dt(null, 'between', ['2026-09-24 08:00', '2026-09-24 10:00'])).toBe(false)
  })

  test('unparseable or empty operands never match a value operator; isEmpty / isNotEmpty are unchanged', () => {
    expect(dt(STORED, 'is', 'not a time')).toBe(false)
    expect(dt(STORED, 'greater', '')).toBe(false)
    expect(dt(null, 'is', '2026-09-24 09:00')).toBe(false)
    expect(dt(null, 'isNot', '2026-09-24 09:00')).toBe(true)
    expect(dt('garbage', 'less', '2026-09-24 09:00')).toBe(false)
    expect(dt(null, 'isEmpty', undefined)).toBe(true)
    expect(dt(STORED, 'isNotEmpty', undefined)).toBe(true)
  })

  test('an unknown operator keeps the pre-existing match-all catch-all', () => {
    expect(dt(STORED, 'contains', '2026')).toBe(true)
  })
})
