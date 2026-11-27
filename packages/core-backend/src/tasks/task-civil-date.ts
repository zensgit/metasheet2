/**
 * Task feature — civil (floating, date-only) calendar arithmetic on `YYYY-MM-DD` strings: add days,
 * day difference, weekday, month length. PURE, no I/O, no clock, no `Intl` (D15: stepping uses
 * `Date.UTC`-style millisecond math plus `getUTCDay()`; a UTC day is always exactly 86 400 000 ms,
 * so no daylight-saving rule can shift a civil date here).
 *
 * Design: docs/development/task-e-m5-pure-functions-design-20261007.md §2.1
 *
 * Only external import: `../utils/calendar-date` (`isValidIsoCalendarDate`, itself import-free and
 * I/O-free — D16).
 */
import { isValidIsoCalendarDate } from '../utils/calendar-date'

// RULED(2026-10-09): [S32] the recurrence module needs civil-day stepping; task D keeps a PRIVATE
// copy of `addCivilDays` in `task-reminders.ts` (not on main). The ruled value is that task E
// exports it from this new file and #6186 switches its private copy to an import on its next rebase,
// so main only ever carries this one copy.

const MS_PER_DAY = 86_400_000

interface CivilParts {
  year: number
  month: number
  day: number
}

function parseCivilDate(date: unknown, fn: string): CivilParts {
  if (typeof date !== 'string') {
    throw new TypeError(`${fn}: date must be a YYYY-MM-DD string`)
  }
  if (!isValidIsoCalendarDate(date)) {
    throw new RangeError(`${fn}: date must be a real YYYY-MM-DD calendar date`)
  }
  const [year, month, day] = date.split('-').map(Number)
  return { year, month, day }
}

/**
 * Epoch-ms of 00:00 UTC on the given civil date. `setUTCFullYear` (not `Date.UTC`) sets the year,
 * because `Date.UTC` reads a two-digit year 0–99 as 1900–1999. `day` may overflow/underflow the
 * month — the platform rolls it over, which is exactly what day arithmetic wants.
 */
function civilToUtcMs(year: number, month: number, day: number): number {
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day)
  d.setUTCHours(0, 0, 0, 0)
  return d.getTime()
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/** Formats an epoch-ms as `YYYY-MM-DD`; anything outside 0001-01-01..9999-12-31 is a RangeError. */
function utcMsToCivil(ms: number, fn: string): string {
  if (!Number.isFinite(ms)) {
    throw new RangeError(`${fn}: result is outside the supported calendar range`)
  }
  const d = new Date(ms)
  const year = d.getUTCFullYear()
  if (year < 1 || year > 9999) {
    throw new RangeError(`${fn}: result is outside 0001-01-01..9999-12-31`)
  }
  const text = `${pad(year, 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`
  if (!isValidIsoCalendarDate(text)) {
    throw new RangeError(`${fn}: result is outside 0001-01-01..9999-12-31`)
  }
  return text
}

function requireSafeInteger(value: unknown, name: string, fn: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(`${fn}: ${name} must be a number`)
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${fn}: ${name} must be a safe integer`)
  }
  return value
}

/** `date` plus `days` whole civil days (negative goes backwards). */
export function addCivilDays(date: string, days: number): string {
  const { year, month, day } = parseCivilDate(date, 'addCivilDays')
  const delta = requireSafeInteger(days, 'days', 'addCivilDays')
  return utcMsToCivil(civilToUtcMs(year, month, day) + delta * MS_PER_DAY, 'addCivilDays')
}

/** Whole civil days from `from` to `to` (`to − from`; negative when `to` is earlier). */
export function civilDayDiff(from: string, to: string): number {
  const a = parseCivilDate(from, 'civilDayDiff')
  const b = parseCivilDate(to, 'civilDayDiff')
  return Math.round(
    (civilToUtcMs(b.year, b.month, b.day) - civilToUtcMs(a.year, a.month, a.day)) / MS_PER_DAY,
  )
}

/** Day of week of a civil date: 0 = Sunday … 6 = Saturday (the `getUTCDay()` numbering). */
export function civilWeekday(date: string): number {
  const { year, month, day } = parseCivilDate(date, 'civilWeekday')
  return new Date(civilToUtcMs(year, month, day)).getUTCDay()
}

/** Number of days in `month` (1–12) of `year` (1–9999), proleptic Gregorian leap rule. */
export function daysInCivilMonth(year: number, month: number): number {
  const y = requireSafeInteger(year, 'year', 'daysInCivilMonth')
  const m = requireSafeInteger(month, 'month', 'daysInCivilMonth')
  if (y < 1 || y > 9999) throw new RangeError('daysInCivilMonth: year must be 1..9999')
  if (m < 1 || m > 12) throw new RangeError('daysInCivilMonth: month must be 1..12')
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
}
