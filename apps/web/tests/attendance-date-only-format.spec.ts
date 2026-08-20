import { describe, expect, it } from 'vitest'
import { formatCalendarDate, isDateOnlyValue, toLocalCalendarDate } from '../src/views/attendance/dateOnlyFormat'

/**
 * `formatCalendarDate` renders a date-only value ('YYYY-MM-DD', e.g. attendance work_date)
 * from local y/m/d components instead of round-tripping through UTC-midnight parsing
 * (`new Date('YYYY-MM-DD')`), which shows the previous calendar day in any timezone west
 * of UTC. Full timestamps are unaffected and still go through the original
 * `new Date(value).toLocaleDateString()` path.
 *
 * Timezone note: vitest's worker-thread pool does not reliably apply `process.env.TZ`
 * mutations to Date/Intl at runtime — verified empirically here (mutating TZ mid-test
 * leaves the host's actual ICU default timezone unchanged inside the worker). So rather
 * than assert a specific offset-dependent literal (which would pass or fail depending on
 * the runner's real system timezone), these tests assert the TZ-INVARIANT property the
 * fix guarantees: for every date-only input, in ANY timezone, the rendered date's
 * year/month/day always equal the input's year/month/day — because construction and
 * rendering both use the same local clock, so they can never disagree. This is exactly
 * the fallback the task calls for: "asserts the formatted output equals the parts of the
 * input string for a date-only input."
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

  it('parses date-only input from LOCAL y/m/d components, not by UTC-parsing the string (host-offset-agnostic epoch check)', () => {
    // This is the actual bug/fix boundary: `new Date('2024-01-15')` (UTC-midnight parse)
    // and `new Date(2024, 0, 15)` (local-midnight construction) are the SAME epoch only
    // when the host timezone offset is exactly 0. Everywhere else — including this host,
    // whatever it is — they differ. toLocalCalendarDate must use the local-construction
    // epoch; reverting to the string-parse form would flip this test red on any non-UTC
    // host (e.g. it fails on this sandbox: UTC+8).
    const parsed = toLocalCalendarDate('2024-01-15')
    expect(parsed).not.toBeNull()
    expect(parsed?.getTime()).toBe(new Date(2024, 0, 15).getTime())
    const hostOffsetMinutes = new Date(2024, 0, 15).getTimezoneOffset()
    if (hostOffsetMinutes !== 0) {
      expect(parsed?.getTime()).not.toBe(Date.UTC(2024, 0, 15))
    }
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
