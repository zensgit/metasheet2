/**
 * Pure (Element-Plus-free) helpers for the `date_range` (日期区间) approval form field type.
 *
 * Lock-8 L8-B (docs/development/approval-lock8-field-vocabulary-20260817.md §1.2, OD-L8-8): a
 * start+end date pair whose duration is DERIVED and DISPLAY-ONLY — never editable, never submitted
 * as authoritative (a submitted duration differing from the derived one is not trusted server-side,
 * ApprovalGraphExecutor.ts's `date_range` value shape is exactly `{ start, end }`, no `duration`
 * key). Mirrors the backend contract (`ApprovalGraphExecutor.ts` `isDateRangeEndpointValid` /
 * `compareDateRangeEndpoints`); duplicated locally because the web app does not import backend
 * sources (same precedent as `prefillFromSnapshot.ts`'s civil-date validator).
 */

export const DATE_RANGE_DATE_TYPES = ['date', 'date_half_day', 'date_minute'] as const
export type DateRangeDateType = (typeof DATE_RANGE_DATE_TYPES)[number]

const ISO_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/

function isValidIsoCalendarDate(value: string): boolean {
  if (!ISO_CALENDAR_DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= daysInMonth[month - 1]
}

/**
 * True when `value` is a valid endpoint string for the declared `dateType` granularity. `'date'`
 * reuses the strict civil-date contract; `'date_half_day'`/`'date_minute'` BOTH reuse the
 * Date.parse-able instant contract (§1.2: exactly D-2's two shipped value contracts, not a third).
 * Fails closed on a missing/off-enum `dateType` — never falls through to the permissive arm.
 */
export function isDateRangeEndpointValid(dateType: unknown, value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false
  if (dateType === 'date') return isValidIsoCalendarDate(value)
  if (dateType === 'date_half_day' || dateType === 'date_minute') {
    return !Number.isNaN(Date.parse(value))
  }
  return false
}

/**
 * OD-L8-8: the derived, display-only duration text between two valid endpoints — `null` when
 * either endpoint is missing/invalid/out of order (B-1 rejects `start > end` at submit; this
 * display simply renders nothing while the author is mid-edit rather than a negative duration).
 * Never stored, never submitted, never editable — a pure projection of `{ start, end }` recomputed
 * on every render.
 */
export function computeDateRangeDurationText(
  dateType: unknown,
  start: unknown,
  end: unknown,
): string | null {
  if (!isDateRangeEndpointValid(dateType, start) || !isDateRangeEndpointValid(dateType, end)) {
    return null
  }
  const startStr = start as string
  const endStr = end as string
  if (dateType === 'date') {
    if (startStr > endStr) return null
    const days = Math.round((Date.parse(endStr) - Date.parse(startStr)) / 86400000)
    return `${days} 天`
  }
  const startMs = Date.parse(startStr)
  const endMs = Date.parse(endStr)
  if (endMs < startMs) return null
  const totalMinutes = Math.round((endMs - startMs) / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} 分钟`
  if (minutes === 0) return `${hours} 小时`
  return `${hours} 小时 ${minutes} 分钟`
}

/** The el-date-picker `type` prop for a given dateType — the civil-date arm gets `'date'`, both
 * time-bearing arms get `'datetime'` (Element Plus has no distinct "half day" picker type; §1.2
 * reuses exactly D-2's two shipped value contracts, not a third widget). */
export function dateRangePickerElementType(dateType: unknown): 'date' | 'datetime' {
  return dateType === 'date' ? 'date' : 'datetime'
}

/** The `value-format` bound to each date_range picker — deterministic strings matching the
 * declared granularity's server-side value contract exactly, so the submitted wire shape never
 * depends on a shipped picker's own default (Date-object) binding. */
export function dateRangePickerValueFormat(dateType: unknown): string {
  return dateType === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:mm:ss'
}
