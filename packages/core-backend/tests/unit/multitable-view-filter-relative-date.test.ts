/**
 * 2a (view filter operators) — relative-date operators on date fields.
 * isToday / isYesterday / isTomorrow / isThisWeek / isThisMonth / isLastNDays / isNextNDays / isOverdue.
 * Pure evaluator, deterministic via the injected clock (4th arg). Day math is UTC, matching how
 * date-only cell strings are parsed, so results are host-timezone-stable.
 */
import { describe, test, expect } from 'vitest'
import { evaluateMetaFilterCondition } from '../../src/routes/univer-meta'

// Fixed "now" = 2026-06-17 (a Wednesday) noon UTC. This week (Mon-start) = Jun 15..21; month = June.
const NOW = Date.UTC(2026, 5, 17, 12, 0, 0)
const d = (cell: unknown, operator: string, value?: unknown) =>
  evaluateMetaFilterCondition('date', cell, { fieldId: 'd', operator, value }, NOW)

describe('view filter — relative-date operators (2a)', () => {
  test('isToday / isYesterday / isTomorrow', () => {
    expect(d('2026-06-17', 'isToday')).toBe(true)
    expect(d('2026-06-16', 'isToday')).toBe(false)
    expect(d('2026-06-16', 'isYesterday')).toBe(true)
    expect(d('2026-06-18', 'isTomorrow')).toBe(true)
    expect(d('2026-06-17', 'isTomorrow')).toBe(false)
  })

  test('isToday is UTC-day stable for a datetime within the same UTC day', () => {
    expect(d('2026-06-17T23:30:00Z', 'isToday')).toBe(true)
    expect(d('2026-06-18T00:30:00Z', 'isToday')).toBe(false)
  })

  test('isThisWeek (Monday-start) covers Mon..Sun of the current week only', () => {
    expect(d('2026-06-15', 'isThisWeek')).toBe(true)  // Monday
    expect(d('2026-06-21', 'isThisWeek')).toBe(true)  // Sunday
    expect(d('2026-06-22', 'isThisWeek')).toBe(false) // next Monday
    expect(d('2026-06-14', 'isThisWeek')).toBe(false) // last Sunday
  })

  test('isThisMonth', () => {
    expect(d('2026-06-01', 'isThisMonth')).toBe(true)
    expect(d('2026-06-30', 'isThisMonth')).toBe(true)
    expect(d('2026-05-31', 'isThisMonth')).toBe(false)
    expect(d('2026-07-01', 'isThisMonth')).toBe(false)
  })

  test('isLastNDays is the inclusive window [now-(N-1) .. now]', () => {
    expect(d('2026-06-11', 'isLastNDays', 7)).toBe(true)  // 7-day window = Jun 11..17
    expect(d('2026-06-17', 'isLastNDays', 7)).toBe(true)  // today is in-window
    expect(d('2026-06-10', 'isLastNDays', 7)).toBe(false) // one day too early
    expect(d('2026-06-18', 'isLastNDays', 7)).toBe(false) // future not in "last"
  })

  test('isNextNDays is the inclusive window [now .. now+N]', () => {
    expect(d('2026-06-17', 'isNextNDays', 7)).toBe(true)
    expect(d('2026-06-24', 'isNextNDays', 7)).toBe(true)
    expect(d('2026-06-25', 'isNextNDays', 7)).toBe(false)
    expect(d('2026-06-16', 'isNextNDays', 7)).toBe(false) // past not in "next"
  })

  test('isLastNDays / isNextNDays never match on an invalid N', () => {
    expect(d('2026-06-17', 'isLastNDays', 0)).toBe(false)
    expect(d('2026-06-17', 'isLastNDays', 'x')).toBe(false)
    expect(d('2026-06-17', 'isNextNDays', -3)).toBe(false)
  })

  test('isOverdue = strictly before today', () => {
    expect(d('2026-06-16', 'isOverdue')).toBe(true)
    expect(d('2026-06-17', 'isOverdue')).toBe(false) // today is not overdue
    expect(d('2026-06-18', 'isOverdue')).toBe(false)
  })

  test('a cell with no date never matches a relative-date operator', () => {
    expect(d(null, 'isToday')).toBe(false)
    expect(d('', 'isThisMonth')).toBe(false)
    expect(d('not-a-date', 'isOverdue')).toBe(false)
  })

  test('non-relative operators still work (helper returns null → falls through)', () => {
    expect(d('2026-06-17', 'is', '2026-06-17')).toBe(true)
    expect(d('2026-06-18', 'greater', '2026-06-17')).toBe(true)
  })
})
