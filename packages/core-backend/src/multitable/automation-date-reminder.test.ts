/**
 * Pure-core unit tests for the date-reminder trigger (`schedule.date_field`). No DB. These pin the two
 * invariants that make idempotency work: occurrence is a PURE, day-bucketed function of (dateValue, config)
 * — never NOW — and the firing window bounds the lower edge so a fresh rule never backfill-blasts history.
 */
import { describe, expect, test } from 'vitest'

import {
  computeDateReminderOccurrence,
  isDateReminderDue,
  dateReminderFloorMs,
  DATE_REMINDER_GRACE_WINDOW_MS,
  nextDateReminderTimerDelayMs,
  dateReminderTimeOfDayPassed,
  dateReminderCandidateDateRange,
} from './automation-date-reminder'

const DAY = 24 * 60 * 60 * 1000

describe('computeDateReminderOccurrence — pure, day-bucketed', () => {
  test('N days BEFORE at a time-of-day', () => {
    expect(
      computeDateReminderOccurrence('2026-06-28T14:30:00.000Z', { offsetDays: 3, direction: 'before', timeOfDay: '09:00' }),
    ).toBe('2026-06-25T09:00:00.000Z')
  })

  test('N days AFTER', () => {
    expect(
      computeDateReminderOccurrence('2026-06-28T00:00:00.000Z', { offsetDays: 2, direction: 'after', timeOfDay: '00:00' }),
    ).toBe('2026-06-30T00:00:00.000Z')
  })

  test('DAY-BUCKETED: the source time-of-day is stripped — same date, different time ⇒ same occurrence', () => {
    const cfg = { offsetDays: 1, direction: 'before' as const, timeOfDay: '09:00' }
    const a = computeDateReminderOccurrence('2026-06-28T00:00:01.000Z', cfg)
    const b = computeDateReminderOccurrence('2026-06-28T23:59:59.000Z', cfg)
    expect(a).toBe('2026-06-27T09:00:00.000Z')
    expect(b).toBe(a) // editing the deadline's time within the same day must NOT change the occurrence
  })

  test('PURE: same inputs ⇒ same output, independent of when called (no NOW leak)', () => {
    const cfg = { offsetDays: 5, direction: 'after' as const, timeOfDay: '12:30' }
    const first = computeDateReminderOccurrence('2026-01-15T08:00:00.000Z', cfg)
    const second = computeDateReminderOccurrence('2026-01-15T08:00:00.000Z', cfg)
    expect(first).toBe(second)
    expect(first).toBe('2026-01-20T12:30:00.000Z')
  })

  test('offset 0 before ⇒ the same day at the configured time', () => {
    expect(
      computeDateReminderOccurrence('2026-06-28T18:00:00.000Z', { offsetDays: 0, direction: 'before', timeOfDay: '09:00' }),
    ).toBe('2026-06-28T09:00:00.000Z')
  })

  test('default time-of-day is 09:00 when omitted/garbage', () => {
    expect(computeDateReminderOccurrence('2026-06-28T18:00:00.000Z', { offsetDays: 0, direction: 'before' })).toBe(
      '2026-06-28T09:00:00.000Z',
    )
    expect(
      computeDateReminderOccurrence('2026-06-28T18:00:00.000Z', { offsetDays: 0, direction: 'before', timeOfDay: 'nope' }),
    ).toBe('2026-06-28T09:00:00.000Z')
  })

  test('null / empty / unparseable date ⇒ null', () => {
    const cfg = { offsetDays: 1, direction: 'before' as const }
    expect(computeDateReminderOccurrence(null, cfg)).toBeNull()
    expect(computeDateReminderOccurrence(undefined, cfg)).toBeNull()
    expect(computeDateReminderOccurrence('', cfg)).toBeNull()
    expect(computeDateReminderOccurrence('not-a-date', cfg)).toBeNull()
  })
})

describe('isDateReminderDue — firing window (backfill bound)', () => {
  const now = Date.parse('2026-06-25T12:00:00.000Z')
  const window = DATE_REMINDER_GRACE_WINDOW_MS // 2 days
  const created = Date.parse('2026-06-01T00:00:00.000Z')

  test('due + within window + after creation ⇒ true', () => {
    expect(isDateReminderDue('2026-06-25T09:00:00.000Z', now, window, created)).toBe(true)
  })

  test('future occurrence ⇒ false (not yet due)', () => {
    expect(isDateReminderDue('2026-06-25T18:00:00.000Z', now, window, created)).toBe(false)
  })

  test('older than the recent window ⇒ false (never backfill-blast)', () => {
    // occurrence 3+ days ago, window is 2 days → outside the window.
    expect(isDateReminderDue('2026-06-22T09:00:00.000Z', now, window, created)).toBe(false)
  })

  test('occurrence before the rule was created ⇒ false (no reach into the past)', () => {
    const createdLate = Date.parse('2026-06-25T11:00:00.000Z')
    expect(isDateReminderDue('2026-06-25T09:00:00.000Z', now, window, createdLate)).toBe(false)
  })

  test('unparseable occurrence ⇒ false', () => {
    expect(isDateReminderDue('garbage', now, window, created)).toBe(false)
  })
})

describe('dateReminderFloorMs — max(createdAt, effectiveAt) closes the conversion-backfill hole', () => {
  const created = Date.parse('2026-01-01T00:00:00.000Z') // months ago
  const activated = Date.parse('2026-06-25T10:00:00.000Z') // converted today

  test('CONVERTED rule: floor is the (later) activation, not the old createdAt', () => {
    expect(dateReminderFloorMs(created, '2026-06-25T10:00:00.000Z')).toBe(activated)
  })

  test('absent effectiveAt (pre-fix date_field rule) ⇒ falls back to createdAt (no behavior change)', () => {
    expect(dateReminderFloorMs(created, undefined)).toBe(created)
    expect(dateReminderFloorMs(created, '')).toBe(created)
    expect(dateReminderFloorMs(created, 'not-a-date')).toBe(created)
  })

  test('effectiveAt earlier than createdAt ⇒ createdAt wins (max)', () => {
    expect(dateReminderFloorMs(activated, '2026-01-01T00:00:00.000Z')).toBe(activated)
  })

  test('a past-48h occurrence on a CONVERTED rule is NOT due (floored by activation)', () => {
    const nowMs = Date.parse('2026-06-25T10:30:00.000Z')
    const floor = dateReminderFloorMs(created, '2026-06-25T10:00:00.000Z') // activation 10:00
    // occurrence 09:00 today — within the 48h window + after old createdAt, but BEFORE activation.
    expect(isDateReminderDue('2026-06-25T09:00:00.000Z', nowMs, DATE_REMINDER_GRACE_WINDOW_MS, floor)).toBe(false)
    // without the fix (floor = old createdAt) it WOULD have fired:
    expect(isDateReminderDue('2026-06-25T09:00:00.000Z', nowMs, DATE_REMINDER_GRACE_WINDOW_MS, created)).toBe(true)
  })
})

describe('DR-A/DR-B timeOfDay-aligned scheduling helpers (PURE)', () => {
  const noon = Date.parse('2026-06-25T12:00:00.000Z') // noon UTC

  test('grace window is a FIXED 48h constant, decoupled from any per-rule cadence (DR-D)', () => {
    expect(DATE_REMINDER_GRACE_WINDOW_MS).toBe(2 * DAY)
  })

  test('nextDateReminderTimerDelayMs: timeOfDay still ahead today ⇒ delay to TODAY boundary', () => {
    expect(nextDateReminderTimerDelayMs('18:00', noon)).toBe(6 * 60 * 60 * 1000) // 12:00 → 18:00 = 6h
  })

  test('nextDateReminderTimerDelayMs: timeOfDay already passed ⇒ delay to TOMORROW boundary (no boot anchor)', () => {
    expect(nextDateReminderTimerDelayMs('09:00', noon)).toBe(21 * 60 * 60 * 1000) // 12:00 → next 09:00 = 21h
    expect(nextDateReminderTimerDelayMs(undefined, noon)).toBe(21 * 60 * 60 * 1000) // default 09:00
  })

  test('dateReminderTimeOfDayPassed: drives the bounded catch-up (boundary inclusive)', () => {
    expect(dateReminderTimeOfDayPassed('09:00', noon)).toBe(true) // 12:00 > 09:00
    expect(dateReminderTimeOfDayPassed('18:00', noon)).toBe(false) // 12:00 < 18:00
    expect(dateReminderTimeOfDayPassed('12:00', noon)).toBe(true) // == now ⇒ passed
  })
})

describe('dateReminderCandidateDateRange — SQL pre-filter brackets the productive date value', () => {
  test("a record whose occurrence lands at NOW has its date value inside the range", () => {
    const now = Date.parse('2026-06-25T12:00:00.000Z')
    const window = DATE_REMINDER_GRACE_WINDOW_MS
    const cfg = { offsetDays: 3, direction: 'before' as const }
    const { loIso, hiIso } = dateReminderCandidateDateRange(now, cfg, window)
    // occurrence = dateDay - 3d. For occurrence ≈ now (06-25), dateDay ≈ 06-28.
    const dateValue = '2026-06-28T10:00:00.000Z'
    expect(dateValue >= loIso && dateValue <= hiIso).toBe(true)
    // a far-future date (occurrence well beyond now) is OUTSIDE the range.
    expect('2026-09-01T00:00:00.000Z' <= hiIso).toBe(false)
  })
})
