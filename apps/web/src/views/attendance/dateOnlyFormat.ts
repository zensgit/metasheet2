/**
 * Timezone-safe formatting for date-only values (e.g. attendance `work_date`, shape
 * 'YYYY-MM-DD').
 *
 * `new Date('YYYY-MM-DD')` is parsed as UTC midnight by the ECMAScript Date constructor,
 * so viewers in timezones west of UTC see the previous calendar day once that Date is
 * rendered with `toLocaleDateString()`. Building the Date from local year/month/day
 * components instead sidesteps the UTC round-trip entirely: the constructed Date already
 * represents local midnight on the intended calendar date, so `toLocaleDateString()`
 * renders the same date regardless of the viewer's timezone offset.
 *
 * Full timestamps (anything that is not a bare 'YYYY-MM-DD' string) are left on the
 * original `new Date(value)` parsing path — only the date-only shape needs the fix.
 */

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** True when `value` is exactly a bare 'YYYY-MM-DD' calendar date (no time component). */
export function isDateOnlyValue(value: string): boolean {
  return DATE_ONLY_PATTERN.test(value)
}

/**
 * Parses a date-only ('YYYY-MM-DD') string into a Date built from LOCAL y/m/d components
 * (`new Date(year, month - 1, day)`) — i.e. local midnight on that calendar date. This is
 * deliberately NOT `new Date(value)`, which parses a bare 'YYYY-MM-DD' string as UTC
 * midnight (the bug this module exists to avoid). Returns null for anything that isn't
 * exactly the date-only shape.
 */
export function toLocalCalendarDate(value: string): Date | null {
  const match = String(value).match(DATE_ONLY_PATTERN)
  if (!match) return null
  const [, yearStr, monthStr, dayStr] = match
  const date = new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr))
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Formats `value` as a locale calendar date. Date-only ('YYYY-MM-DD') inputs are rendered
 * from local y/m/d components via `toLocalCalendarDate` (no UTC round-trip); anything else
 * falls through to `new Date(value).toLocaleDateString(locale)`. Returns `fallback` for
 * empty/blank input, and the trimmed original string when it fails to parse as a date at
 * all.
 */
export function formatCalendarDate(
  value: string | null | undefined,
  locale: string,
  fallback = '--',
): string {
  if (!value) return fallback
  const direct = String(value).trim()
  if (!direct) return fallback

  const localDate = toLocalCalendarDate(direct)
  if (localDate) return localDate.toLocaleDateString(locale)

  const date = new Date(direct)
  if (Number.isNaN(date.getTime())) return direct
  return date.toLocaleDateString(locale)
}
