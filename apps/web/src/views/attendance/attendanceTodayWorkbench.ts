/**
 * Today-only employee workbench selection.
 *
 * Design-lock §4.1: a historical fallback record must never be presented as
 * today's timeline, and must not seed dedicated request work dates.
 * Issues #5986 and #5990.
 */

export interface HeroTodayTimeline {
  checkIn: string | null
  checkOut: string | null
}

/** The row whose `work_date` is exactly the rule-timezone today key, or null. */
export function selectTodayAttendanceRecord<T extends { work_date: string }>(
  records: readonly T[] | null | undefined,
  todayWorkDateKey: string | null | undefined,
): T | null {
  const key = String(todayWorkDateKey ?? '').trim()
  if (!key || !records || records.length === 0) return null
  return records.find(record => record.work_date === key) ?? null
}

/**
 * Two-node punch timeline for today's row only.
 * No row → null, so clock / punch emphasis stay on "not clocked in".
 */
export function buildHeroTodayTimeline(
  record: { first_in_at?: string | null; last_out_at?: string | null } | null | undefined,
  formatClock: (value: string | null | undefined) => string | null,
): HeroTodayTimeline | null {
  if (!record) return null
  return {
    checkIn: formatClock(record.first_in_at),
    checkOut: formatClock(record.last_out_at),
  }
}

/**
 * Default work date for dedicated leave / overtime / shift-swap cards, and the
 * makeup card when no qualifying anomaly exists. Never a historical work_date.
 */
export function resolveDedicatedRequestWorkDate(todayWorkDateKey: string | null | undefined): string {
  return String(todayWorkDateKey ?? '').trim()
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Widen the untouched browser-local default history window so the rule-timezone
 * today key is inside `[from, to]`. A window the user (or calendar) already
 * changed is left alone.
 */
export function alignDefaultHistoryRangeToRuleToday(input: {
  fromDate: string
  toDate: string
  todayKey: string
  initialFromDate: string
  initialToDate: string
}): { fromDate: string; toDate: string; changed: boolean } {
  const todayKey = String(input.todayKey ?? '').trim()
  const unchanged = {
    fromDate: input.fromDate,
    toDate: input.toDate,
    changed: false,
  }
  if (!DATE_ONLY.test(todayKey)) return unchanged
  if (input.fromDate !== input.initialFromDate || input.toDate !== input.initialToDate) {
    return unchanged
  }
  if (todayKey >= input.fromDate && todayKey <= input.toDate) return unchanged
  let fromDate = input.fromDate
  let toDate = input.toDate
  if (todayKey > toDate) toDate = todayKey
  if (todayKey < fromDate) fromDate = todayKey
  return {
    fromDate,
    toDate,
    changed: fromDate !== input.fromDate || toDate !== input.toDate,
  }
}
