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
  DATE_REMINDER_LEDGER_RETENTION_DAYS,
  DATE_REMINDER_LEDGER_RETENTION_MS,
  nextDateReminderTimerDelayMs,
  dateReminderTimeOfDayPassed,
  dateReminderCandidateDateRange,
  dateReminderLedgerRetentionCutoffIso,
  MAX_DATE_REMINDER_OFFSET_DAYS,
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

describe('computeDateReminderOccurrence — timezone-aware (T2-5)', () => {
  const NY = 'America/New_York'

  test('UTC default path is unchanged when timezone is absent / "UTC"', () => {
    const cfg = { offsetDays: 3, direction: 'before' as const, timeOfDay: '09:00' }
    expect(computeDateReminderOccurrence('2026-06-28T14:30:00.000Z', cfg)).toBe('2026-06-25T09:00:00.000Z')
    expect(computeDateReminderOccurrence('2026-06-28T14:30:00.000Z', { ...cfg, timezone: 'UTC' })).toBe(
      '2026-06-25T09:00:00.000Z',
    )
  })

  test('non-UTC zone: timeOfDay is LOCAL wall-clock, converted to UTC (EDT = UTC-4)', () => {
    // 0 days before, fire 09:00 America/New_York on 2026-06-15 (EDT) = 13:00 UTC.
    expect(
      computeDateReminderOccurrence('2026-06-15T20:00:00.000Z', {
        offsetDays: 0,
        direction: 'before',
        timeOfDay: '09:00',
        timezone: NY,
      }),
    ).toBe('2026-06-15T13:00:00.000Z')
  })

  test('non-UTC zone: day-bucket uses the LOCAL calendar day of the source date', () => {
    // 2026-06-16T02:00:00Z is still 2026-06-15 22:00 LOCAL (EDT). So the local day is the 15th, and a
    // 0-offset 09:00 reminder fires 2026-06-15 09:00 EDT = 13:00 UTC (NOT the 16th).
    expect(
      computeDateReminderOccurrence('2026-06-16T02:00:00.000Z', {
        offsetDays: 0,
        direction: 'before',
        timeOfDay: '09:00',
        timezone: NY,
      }),
    ).toBe('2026-06-15T13:00:00.000Z')
  })

  test('runtime defense: an invalid IANA tz degrades to UTC bucketing (never throws, no null)', () => {
    let occ: string | null = null
    expect(() => {
      occ = computeDateReminderOccurrence('2026-06-28T14:30:00.000Z', {
        offsetDays: 3,
        direction: 'before',
        timeOfDay: '09:00',
        timezone: 'Not/AZone',
      })
    }).not.toThrow()
    // Identical to the UTC path.
    expect(occ).toBe('2026-06-25T09:00:00.000Z')
  })
})

describe('computeDateReminderOccurrence — FLOATING date-only field (Option 1: date vs dateTime)', () => {
  const NY = 'America/New_York' // EST = UTC-5 in March (before DST), EDT = UTC-4 in summer

  // THE regression lock. A `date`-type field stores a bare 'YYYY-MM-DD' (the date-picker output). A date-only
  // value has NO instant, so its calendar day must NOT move with timezone. "3 days before 2026-03-08, 09:00"
  // in New York must be Mar 5 09:00 EST (= 14:00Z), NOT Mar 4. Before the fix the bare date was parsed to UTC
  // midnight then re-zoned to the PREVIOUS NY day, firing a civil day early.
  test('floating + negative-offset tz: the bare calendar day does NOT shift (Mar 8 → Mar 5 09:00 EST)', () => {
    expect(
      computeDateReminderOccurrence(
        '2026-03-08',
        { offsetDays: 3, direction: 'before', timeOfDay: '09:00', timezone: NY },
        { floating: true },
      ),
    ).toBe('2026-03-05T14:00:00.000Z')
  })

  // The SAME shape WITHOUT floating (a real dateTime instant at UTC-midnight) keeps instant→local-day
  // semantics: 2026-03-08T00:00Z is locally Mar 7 in NY, so 3-before lands Mar 4. This is CORRECT for an
  // instant and documents exactly why the two field types must diverge — the floating fix must not touch it.
  test('instant (dateTime) default is UNCHANGED: a UTC-midnight instant re-zones to the previous NY day', () => {
    const cfg = { offsetDays: 3, direction: 'before' as const, timeOfDay: '09:00', timezone: NY }
    expect(computeDateReminderOccurrence('2026-03-08T00:00:00.000Z', cfg)).toBe('2026-03-04T14:00:00.000Z')
    // floating:false is identical to omitting opts.
    expect(computeDateReminderOccurrence('2026-03-08T00:00:00.000Z', cfg, { floating: false })).toBe(
      '2026-03-04T14:00:00.000Z',
    )
  })

  test('floating + positive-offset tz (Asia/Shanghai +8): no shift either way (Mar 5 09:00 CST = Mar 5 01:00Z)', () => {
    expect(
      computeDateReminderOccurrence(
        '2026-03-08',
        { offsetDays: 3, direction: 'before', timeOfDay: '09:00', timezone: 'Asia/Shanghai' },
        { floating: true },
      ),
    ).toBe('2026-03-05T01:00:00.000Z')
  })

  test('floating UTC path is byte-identical (no tz): the bare date buckets in UTC exactly as before', () => {
    expect(
      computeDateReminderOccurrence('2026-03-08', { offsetDays: 3, direction: 'before', timeOfDay: '09:00' }, { floating: true }),
    ).toBe('2026-03-05T09:00:00.000Z')
  })

  test('floating + DST spring-forward gap: a non-existent local timeOfDay resolves FORWARD (not skipped)', () => {
    // floating Mar 8, 0-before, 02:30 NY — 02:30 does not exist on the spring-forward day → 03:30 EDT = 07:30Z.
    expect(
      computeDateReminderOccurrence(
        '2026-03-08',
        { offsetDays: 0, direction: 'before', timeOfDay: '02:30', timezone: NY },
        { floating: true },
      ),
    ).toBe('2026-03-08T07:30:00.000Z')
  })

  test('floating with a full-ISO-midnight value (legacy date stored as ISO): still the literal civil day', () => {
    // A date-only field whose value was persisted as full-ISO-midnight must STILL take the literal day, so the
    // floating fallback (UTC parts) gives Mar 8 → Mar 5 09:00 EST, not the re-zoned Mar 7.
    expect(
      computeDateReminderOccurrence(
        '2026-03-08T00:00:00.000Z',
        { offsetDays: 3, direction: 'before', timeOfDay: '09:00', timezone: NY },
        { floating: true },
      ),
    ).toBe('2026-03-05T14:00:00.000Z')
  })

  test('floating null/empty/unparseable ⇒ null (unchanged)', () => {
    const cfg = { offsetDays: 1, direction: 'before' as const, timezone: NY }
    expect(computeDateReminderOccurrence(null, cfg, { floating: true })).toBeNull()
    expect(computeDateReminderOccurrence('', cfg, { floating: true })).toBeNull()
    expect(computeDateReminderOccurrence('not-a-date', cfg, { floating: true })).toBeNull()
  })
})

describe('date-reminder timer boundary — timezone-aware (T2-5)', () => {
  const NY = 'America/New_York'

  test('UTC default path unchanged: delay lands on the UTC timeOfDay boundary', () => {
    // 2026-06-15T06:00:00Z, timeOfDay 09:00 UTC → fire at 09:00 UTC, 3h out.
    const now = Date.parse('2026-06-15T06:00:00.000Z')
    expect(nextDateReminderTimerDelayMs('09:00', now)).toBe(3 * 60 * 60 * 1000)
    expect(dateReminderTimeOfDayPassed('09:00', now)).toBe(false)
  })

  test('non-UTC zone: the timer fires at the LOCAL timeOfDay, not the UTC one', () => {
    // 2026-06-15T06:00:00Z. 09:00 America/New_York (EDT) = 13:00 UTC → still ahead, delay = 7h.
    const now = Date.parse('2026-06-15T06:00:00.000Z')
    const delay = nextDateReminderTimerDelayMs('09:00', now, NY)
    expect(now + delay).toBe(Date.parse('2026-06-15T13:00:00.000Z'))
    expect(dateReminderTimeOfDayPassed('09:00', now, NY)).toBe(false)
  })

  test('non-UTC zone: when today’s local boundary has passed, advance to the next LOCAL day', () => {
    // 2026-06-15T16:00:00Z = 12:00 EDT, past 09:00 local → next is 2026-06-16 09:00 EDT = 2026-06-16 13:00 UTC.
    const now = Date.parse('2026-06-15T16:00:00.000Z')
    const delay = nextDateReminderTimerDelayMs('09:00', now, NY)
    expect(now + delay).toBe(Date.parse('2026-06-16T13:00:00.000Z'))
    expect(dateReminderTimeOfDayPassed('09:00', now, NY)).toBe(true)
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

describe('date-reminder ledger retention helpers (PURE)', () => {
  test('retention window is fixed at 365 days', () => {
    expect(DATE_REMINDER_LEDGER_RETENTION_DAYS).toBe(365)
    expect(DATE_REMINDER_LEDGER_RETENTION_MS).toBe(365 * DAY)
  })

  test('dateReminderLedgerRetentionCutoffIso: cutoff is based on fired_at age', () => {
    const now = Date.parse('2026-06-29T12:00:00.000Z')
    expect(dateReminderLedgerRetentionCutoffIso(now)).toBe('2025-06-29T12:00:00.000Z')
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

  test('DATE-ONLY bounds: a bare YYYY-MM-DD on the boundary day is INCLUDED (full-ISO bounds would drop it)', () => {
    const now = Date.parse('2026-06-25T12:00:00.000Z')
    const window = DATE_REMINDER_GRACE_WINDOW_MS
    const cfg = { offsetDays: 3, direction: 'before' as const }
    const { loIso, hiIso } = dateReminderCandidateDateRange(now, cfg, window)
    // Bounds are date-only ('YYYY-MM-DD') so the lexicographic SQL BETWEEN is exact for a bare date value.
    expect(loIso).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(hiIso).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // The productive bare date (occurrence ≈ now ⇒ dateDay ≈ 06-28) is inside the range.
    expect('2026-06-28' >= loIso && '2026-06-28' <= hiIso).toBe(true)
    // A bare date sitting exactly on the lo boundary day is INCLUDED now…
    const bareOnLoDay = loIso // loIso is itself a bare date on the lo civil day
    expect(bareOnLoDay >= loIso).toBe(true)
    // …whereas the OLD full-ISO lower bound (a time-suffixed instant on the same day) would have EXCLUDED it,
    // because the bare string is a prefix of the timestamp and sorts BEFORE it. This is the boundary-luck fix.
    const oldFullIsoLo = `${loIso}T12:00:00.000Z`
    expect(bareOnLoDay >= oldFullIsoLo).toBe(false)
  })

  test('offsetDays defense-in-depth: bounded at the cap, and a PERSISTED out-of-range value DEGRADES (no throw)', () => {
    const now = Date.parse('2026-06-25T12:00:00.000Z')
    const window = DATE_REMINDER_GRACE_WINDOW_MS
    // At the sanity cap the range math stays inside the JS Date range — valid date-only bounds.
    const atCap = dateReminderCandidateDateRange(now, { offsetDays: MAX_DATE_REMINDER_OFFSET_DAYS, direction: 'after' }, window)
    expect(atCap.loIso).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(atCap.hiIso).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // The save cap (validateDateFieldTriggerAtSave) rejects new out-of-range rules; for a PERSISTED junk value
    // (direct-DB / pre-cap) the runtime clamp degrades to bounded output instead of throwing a RangeError that
    // would abort the whole scan. The clamped 1e12 produces the SAME bounds as the cap (magnitude clamp).
    let degraded: { loIso: string; hiIso: string } | null = null
    expect(() => {
      degraded = dateReminderCandidateDateRange(now, { offsetDays: 1e12, direction: 'after' }, window)
    }).not.toThrow()
    expect(degraded!).toEqual(atCap)
    // The occurrence path degrades too (no throw) for a persisted huge offset.
    expect(() =>
      computeDateReminderOccurrence('2026-06-28', { offsetDays: 1e12, direction: 'after', timeOfDay: '09:00' }),
    ).not.toThrow()
  })
})
