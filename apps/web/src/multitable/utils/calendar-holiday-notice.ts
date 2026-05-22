import type { CalendarVisibleRange } from '../../composables/useCalendarDays'
import { viewRenderLabel } from './meta-view-render-labels'

export type CalendarHolidayFetchState = 'idle' | 'waiting-for-user' | 'loading' | 'ready' | 'empty' | 'error'

// The hint should not appear for naturally quiet months such as July/August.
// These month anchors cover the common China public-holiday windows used by
// the attendance holiday-cn sync path, while keeping the UI quiet elsewhere.
const HOLIDAY_EXPECTATION_MONTHS = new Set([1, 2, 4, 5, 6, 9, 10])

function parseDateKey(value: string | null | undefined): Date | null {
  const raw = String(value || '').trim()
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const [, y, m, d] = match
  const date = new Date(Number(y), Number(m) - 1, Number(d))
  return Number.isNaN(date.getTime()) ? null : date
}

export function visibleRangeHasHolidayExpectation(range: CalendarVisibleRange | null | undefined): boolean {
  const from = parseDateKey(range?.from)
  const to = parseDateKey(range?.to)
  if (!from || !to || from.getTime() > to.getTime()) return false

  const cursor = new Date(from.getFullYear(), from.getMonth(), 1)
  const end = new Date(to.getFullYear(), to.getMonth(), 1)
  while (cursor.getTime() <= end.getTime()) {
    if (HOLIDAY_EXPECTATION_MONTHS.has(cursor.getMonth() + 1)) return true
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return false
}

export function calendarHolidaySyncNotice(options: {
  state: CalendarHolidayFetchState
  range: CalendarVisibleRange | null | undefined
  isZh: boolean
}): string | null {
  if (options.state !== 'empty') return null
  if (!visibleRangeHasHolidayExpectation(options.range)) return null
  return viewRenderLabel('calendar.holidayDataMissingHint', options.isZh)
}
