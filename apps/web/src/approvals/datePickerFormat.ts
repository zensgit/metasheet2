/**
 * Test report 2026-10-08, item T4a (plus its adjacent E1/E2): the ONE place the approval fill
 * surfaces take their `date` / `datetime` picker settings from — ApprovalNewView's top-level fields
 * and 明细 (detail) cells, and TemplateAuthoringView's try-run form. Kept free of Vue and Element
 * Plus so a spec can mount the real picker with exactly these values.
 *
 * `datetime` (an INSTANT, Lock-8 D-2): the stored value stays what the picker binds without a
 * `value-format` (a `Date`, serialized by `JSON.stringify` as a UTC ISO string) — unchanged. What
 * changes is how it is entered:
 *   - `format` is minute-granular. Element Plus derives the panel's time-input format from it, so a
 *     time typed as `10:30` is now accepted; with the library default (`HH:mm:ss`) it was dropped
 *     without any message and the value stayed at midnight.
 *   - `default-time` is "now, truncated to the minute": clicking only a calendar day now carries a
 *     real time of day instead of the library's 00:00:00. Element Plus reads `default-time` once,
 *     when the picker mounts (its panel is rendered persistently), so the value is the time the
 *     form was opened, not the time the panel is clicked. Seconds and milliseconds are zeroed so
 *     the stored instant never carries precision the `HH:mm` display hides.
 *
 * `date` (a floating civil date, Lock-8 D-2): bound with `value-format="YYYY-MM-DD"`, so the model
 * is exactly the strict calendar string the server validates (`utils/calendar-date.ts`). Without
 * it the picker bound a `Date` for local midnight, which reaches the server as a full ISO instant
 * and is refused as `must be a date value`.
 */
export const APPROVAL_CIVIL_DATE_VALUE_FORMAT = 'YYYY-MM-DD'

export const APPROVAL_DATETIME_DISPLAY_FORMAT = 'YYYY-MM-DD HH:mm'

/** The `default-time` for a datetime picker: `now` with seconds and milliseconds zeroed. */
export function approvalDatetimeDefaultTime(now: Date = new Date()): Date {
  const value = new Date(now.getTime())
  value.setSeconds(0, 0)
  return value
}
