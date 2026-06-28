/**
 * Pure-core unit tests for the date-reminder trigger (`schedule.date_field`). No DB. These pin the two
 * invariants that make idempotency work: occurrence is a PURE, day-bucketed function of (dateValue, config)
 * — never NOW — and the firing window bounds the lower edge so a fresh rule never backfill-blasts history.
 */
import { describe, expect, test } from 'vitest'

import {
  computeDateReminderOccurrence,
  isDateReminderDue,
  dateReminderScanIntervalMs,
  dateReminderScanWindowMs,
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
  const window = dateReminderScanWindowMs(DAY) // 2 days
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

describe('dateReminderScanIntervalMs — clamp [1h, 7d], default daily', () => {
  test('default = 24h', () => {
    expect(dateReminderScanIntervalMs({})).toBe(DAY)
  })
  test('floor at 1h', () => {
    expect(dateReminderScanIntervalMs({ scanIntervalMs: 1000 })).toBe(60 * 60 * 1000)
  })
  test('cap at 7d', () => {
    expect(dateReminderScanIntervalMs({ scanIntervalMs: 999 * DAY })).toBe(7 * DAY)
  })
})

describe('dateReminderCandidateDateRange — SQL pre-filter brackets the productive date value', () => {
  test("a record whose occurrence lands at NOW has its date value inside the range", () => {
    const now = Date.parse('2026-06-25T12:00:00.000Z')
    const window = dateReminderScanWindowMs(DAY)
    const cfg = { offsetDays: 3, direction: 'before' as const }
    const { loIso, hiIso } = dateReminderCandidateDateRange(now, cfg, window)
    // occurrence = dateDay - 3d. For occurrence ≈ now (06-25), dateDay ≈ 06-28.
    const dateValue = '2026-06-28T10:00:00.000Z'
    expect(dateValue >= loIso && dateValue <= hiIso).toBe(true)
    // a far-future date (occurrence well beyond now) is OUTSIDE the range.
    expect('2026-09-01T00:00:00.000Z' <= hiIso).toBe(false)
  })
})
