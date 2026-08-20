import { describe, expect, it } from 'vitest'
import { formatCalendarDate, isDateOnlyValue, toLocalCalendarDate } from '../src/views/attendance/dateOnlyFormat'

/**
 * `formatCalendarDate` renders a date-only value ('YYYY-MM-DD', e.g. attendance work_date)
 * from local y/m/d components instead of round-tripping through UTC-midnight parsing
 * (`new Date('YYYY-MM-DD')`), which shows the previous calendar day in any timezone west
 * of UTC. Full timestamps are unaffected and still go through the original
 * `new Date(value).toLocaleDateString()` path.
 *
 * Timezone note (corrected per GATE-5047 P2-1): *mutating* `process.env.TZ` mid-test does
 * not reliably re-derive Node/ICU's resolved timezone inside an already-running vitest
 * worker (verified empirically). Setting `TZ` on a freshly spawned process's environment
 * DOES work — Node reads it once at startup. Because this repo's CI runs on UTC-hosted
 * runners with no `TZ` env set, and the west-of-UTC failure mode is invisible at offset 0,
 * the TZ-invariant assertions below (true in every timezone, by construction) are NOT on
 * their own sufficient evidence that this spec would catch a regression in CI — they would
 * pass just as well if the fix were silently reverted to the buggy `new Date(value)` path,
 * as long as CI keeps running at UTC. The CI-discriminating check lives in the companion
 * spec attendance-date-only-format-tz-probe.spec.ts, which spawns real child processes
 * with an explicit non-UTC `TZ` and asserts against BOTH the fixed module's output and an
 * independently-computed old-path negative control — regardless of what timezone the
 * outer `vitest run` process (i.e. the CI host) happens to be running under.
 */
describe('formatCalendarDate (timezone-safe date-only rendering)', () => {
  it.each([
    ['2024-01-15', '1/15/2024'],
    ['2024-01-01', '1/1/2024'], // start of year
    ['2024-12-31', '12/31/2024'], // end of year
    ['2024-02-29', '2/29/2024'], // leap day
    ['2023-02-28', '2/28/2023'], // Feb boundary in a non-leap year
    ['2024-03-01', '3/1/2024'], // day after a leap-day month
    ['2024-11-03', '11/3/2024'], // a US DST "fall back" date — the local-midnight
    // construction must still land on the same calendar day even across a DST transition
  ])('renders date-only %s as the exact same calendar date (%s, en-US) regardless of host timezone', (input, expected) => {
    expect(formatCalendarDate(input, 'en-US')).toBe(expected)
  })

  it('parses date-only input from LOCAL y/m/d components (basic construction sanity check)', () => {
    // Tautological at a UTC host (local-construction epoch === UTC-midnight epoch when
    // offset is 0) — NOT the regression guard. That's
    // attendance-date-only-format-tz-probe.spec.ts, which is host-TZ-independent by
    // spawning its own child processes with an explicit non-UTC TZ.
    const parsed = toLocalCalendarDate('2024-01-15')
    expect(parsed).not.toBeNull()
    expect(parsed?.getTime()).toBe(new Date(2024, 0, 15).getTime())
  })

  it('returns null from toLocalCalendarDate for non-date-only input', () => {
    expect(toLocalCalendarDate('2024-01-15T00:00:00.000Z')).toBeNull()
    expect(toLocalCalendarDate('not-a-date')).toBeNull()
    expect(toLocalCalendarDate('')).toBeNull()
  })

  it('positive control: a full ISO timestamp is NOT treated as date-only and takes the ordinary Date-parsing path', () => {
    const timestamp = '2024-01-15T02:00:00.000Z'
    expect(isDateOnlyValue(timestamp)).toBe(false)
    // Bypassing formatCalendarDate and calling new Date(...).toLocaleDateString(...)
    // directly reproduces the identical output — proving the function adds no special
    // handling for non-date-only values; whatever the host timezone legitimately does to
    // a full timestamp, formatCalendarDate does the same (unlike the date-only branch,
    // which is deliberately timezone-invariant).
    expect(formatCalendarDate(timestamp, 'en-US')).toBe(new Date(timestamp).toLocaleDateString('en-US'))
  })

  it('returns the fallback for null/undefined/empty/blank input', () => {
    expect(formatCalendarDate(null, 'en-US')).toBe('--')
    expect(formatCalendarDate(undefined, 'en-US')).toBe('--')
    expect(formatCalendarDate('', 'en-US')).toBe('--')
    expect(formatCalendarDate('   ', 'en-US')).toBe('--')
  })

  it('accepts a custom fallback', () => {
    expect(formatCalendarDate(null, 'en-US', 'n/a')).toBe('n/a')
  })

  it('returns the trimmed original string for unparseable input', () => {
    expect(formatCalendarDate('not-a-date', 'en-US')).toBe('not-a-date')
    expect(formatCalendarDate('  garbage-value  ', 'en-US')).toBe('garbage-value')
  })

  it('rejects near-shaped strings as NOT date-only (falls through to full Date parsing)', () => {
    // These must NOT take the local-parts path — they are not exactly 'YYYY-MM-DD'.
    expect(isDateOnlyValue('2024-1-15')).toBe(false) // unpadded month
    expect(isDateOnlyValue('2024-01-5')).toBe(false) // unpadded day
    expect(isDateOnlyValue('2024-01-15T00:00:00')).toBe(false) // has a time component
    expect(isDateOnlyValue('2024-01-15 ')).toBe(false) // trailing whitespace
    expect(isDateOnlyValue(' 2024-01-15')).toBe(false) // leading whitespace
    expect(isDateOnlyValue('24-01-15')).toBe(false) // 2-digit year
  })

  it('recognizes the exact date-only shape', () => {
    expect(isDateOnlyValue('2024-01-15')).toBe(true)
    expect(isDateOnlyValue('0001-01-01')).toBe(true)
  })
})
