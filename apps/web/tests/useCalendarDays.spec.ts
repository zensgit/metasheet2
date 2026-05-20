import { describe, expect, it, vi } from 'vitest'
import {
  buildCalendarDays,
  formatLunarDayLabel,
  getCalendarVisibleRange,
  groupCalendarHolidaysByDate,
} from '../src/composables/useCalendarDays'

describe('useCalendarDays shared calendar helpers', () => {
  it('builds reusable day cells with holidays, working-day overrides, today, and lunar labels', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-17T12:00:00Z'))

    const holidays = [
      { id: 'holiday_spring', date: '2026-02-17', name: '春节', isWorkingDay: false },
      { id: 'working_sat', date: '2026-02-21', name: '调休', isWorkingDay: true },
    ]
    const days = buildCalendarDays({
      startDate: new Date(2026, 1, 15),
      days: 7,
      currentMonth: new Date(2026, 1, 1),
      holidays,
      showLunarCalendar: true,
    })

    const springFestival = days.find((day) => day.date === '2026-02-17')
    expect(springFestival?.isToday).toBe(true)
    expect(springFestival?.holidays).toEqual([holidays[0]])
    expect(springFestival?.lunarLabel).toBeTruthy()

    const workingOverride = days.find((day) => day.date === '2026-02-21')
    expect(workingOverride?.holidays[0]?.isWorkingDay).toBe(true)

    vi.useRealTimers()
  })

  it('normalizes holiday dates before grouping and preserves calendar visible range compatibility', () => {
    const grouped = groupCalendarHolidaysByDate([
      { id: 'holiday_1', date: '2026-02-17T00:00:00.000Z', name: 'Holiday' },
    ])
    expect(grouped.get('2026-02-17')?.[0]?.id).toBe('holiday_1')

    expect(getCalendarVisibleRange(new Date(2026, 1, 1))).toEqual({
      from: '2026-01-26',
      to: '2026-03-01',
    })
  })

  it('keeps lunar formatting optional for consumers that only need plain date grids', () => {
    const date = new Date('2026-02-17T12:00:00Z')
    expect(formatLunarDayLabel(date, { enabled: false })).toBeUndefined()
    expect(formatLunarDayLabel(date, { enabled: true })).toBeTruthy()
  })
})
