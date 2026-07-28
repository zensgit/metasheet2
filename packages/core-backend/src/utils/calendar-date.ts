/**
 * Floating civil (date-only) calendar validation — strict `YYYY-MM-DD` with real
 * proleptic-Gregorian leap-year rules.
 *
 * A `date`-typed approval form value is a FLOATING calendar day, not an instant: it must
 * never be derived from, or reinterpreted through, `Date.parse` / `Date` / `toISOString`
 * (those define INSTANT semantics and can shift the calendar day across timezones).
 * Validation here is purely lexical + arithmetic, so an approved string compares and
 * persists byte-for-byte in every timezone.
 *
 * Strict by contract: no surrounding whitespace, no datetime suffixes, no locale formats.
 * (The approval form transport — `pruneHiddenFormData` — passes values through untouched;
 * nothing trims before validation, so padding is rejected rather than silently normalized.)
 */
const ISO_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isValidIsoCalendarDate(value: string): boolean {
  if (!ISO_CALENDAR_DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= daysInMonth[month - 1]
}
