export interface CalendarVisibleRange {
  from: string
  to: string
}

export interface CalendarHoliday {
  id: string
  date: string
  name?: string | null
  isWorkingDay?: boolean
}

export interface CalendarDayCell<THoliday extends { date: string } = CalendarHoliday> {
  date: string
  dayNumber: number
  isCurrentMonth: boolean
  isToday: boolean
  holidays: THoliday[]
  lunarLabel?: string
}

interface DateTimeLabelOptions {
  locale: string
  timeZone?: string
}

interface LunarLabelOptions {
  enabled: boolean
  timeZone?: string
}

interface BuildCalendarDayOptions<THoliday extends { date: string }> {
  currentMonth?: Date
  holidays?: THoliday[]
  holidaysByDate?: Map<string, THoliday[]>
  isCurrentMonth?: boolean
  lunarTimeZone?: string
  showLunarCalendar?: boolean
  today?: Date
}

interface BuildCalendarDaysOptions<THoliday extends { date: string }> extends BuildCalendarDayOptions<THoliday> {
  days: number
  startDate: Date
}

const DEFAULT_LUNAR_TIME_ZONE = 'Asia/Shanghai'

export function toDateInput(date: Date): string {
  return toDateKey(date)
}

export function toDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function normalizeDateKey(value: string | null | undefined): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  const direct = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  if (direct) return direct[1]
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return null
  return toDateKey(date)
}

export function parseDateOnly(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day))
  return Number.isNaN(date.getTime()) ? null : date
}

export function compareDateKeys(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

export function firstDayOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

export function lastDayOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0)
}

export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
}

export function getCalendarVisibleRange(calendarMonth: Date): CalendarVisibleRange {
  const monthStart = firstDayOfMonth(calendarMonth)
  const monthEnd = lastDayOfMonth(calendarMonth)
  const startOffset = (monthStart.getDay() + 6) % 7
  const endOffset = 6 - ((monthEnd.getDay() + 6) % 7)
  const visibleStart = new Date(monthStart)
  visibleStart.setDate(visibleStart.getDate() - startOffset)
  const visibleEnd = new Date(monthEnd)
  visibleEnd.setDate(visibleEnd.getDate() + endOffset)
  return {
    from: toDateInput(visibleStart),
    to: toDateInput(visibleEnd),
  }
}

export function formatCalendarMonthLabel(date: Date, options: DateTimeLabelOptions): string {
  const locale = String(options.locale || 'en-US')
  const timeZone = String(options.timeZone || '').trim()
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
      ...(timeZone ? { timeZone } : {}),
    }).format(date)
  } catch {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
    }).format(date)
  }
}

export function formatLunarDayLabel(date: Date, options: LunarLabelOptions): string | undefined {
  if (!options.enabled || Number.isNaN(date.getTime())) return undefined
  const timeZone = String(options.timeZone || DEFAULT_LUNAR_TIME_ZONE).trim()
  try {
    const text = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      month: 'short',
      day: 'numeric',
      ...(timeZone ? { timeZone } : {}),
    }).format(date)
    const normalized = text.replace(/\s+/g, '')
    if (normalized) return normalized
  } catch {
    // Fall back to the runtime timezone when the provided timezone is invalid.
  }

  try {
    const text = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      month: 'short',
      day: 'numeric',
    }).format(date)
    const normalized = text.replace(/\s+/g, '')
    return normalized || undefined
  } catch {
    return undefined
  }
}

export function groupCalendarHolidaysByDate<THoliday extends { date: string }>(
  holidays: readonly THoliday[],
): Map<string, THoliday[]> {
  const map = new Map<string, THoliday[]>()
  for (const holiday of holidays) {
    const key = normalizeDateKey(holiday.date)
    if (!key) continue
    if (!map.has(key)) map.set(key, [])
    map.get(key)?.push(holiday)
  }
  return map
}

export function buildCalendarDay<THoliday extends { date: string }>(
  date: Date,
  options: BuildCalendarDayOptions<THoliday> = {},
): CalendarDayCell<THoliday> {
  const dateKey = toDateKey(date)
  const holidaysByDate = options.holidaysByDate ?? groupCalendarHolidaysByDate(options.holidays ?? [])
  const today = options.today ?? new Date()
  return {
    date: dateKey,
    dayNumber: date.getDate(),
    isCurrentMonth: typeof options.isCurrentMonth === 'boolean'
      ? options.isCurrentMonth
      : options.currentMonth
        ? isSameMonth(date, options.currentMonth)
        : true,
    isToday: dateKey === toDateKey(today),
    holidays: holidaysByDate.get(dateKey) ?? [],
    lunarLabel: formatLunarDayLabel(date, {
      enabled: Boolean(options.showLunarCalendar),
      timeZone: options.lunarTimeZone,
    }),
  }
}

export function buildCalendarDays<THoliday extends { date: string }>(
  options: BuildCalendarDaysOptions<THoliday>,
): CalendarDayCell<THoliday>[] {
  const holidaysByDate = options.holidaysByDate ?? groupCalendarHolidaysByDate(options.holidays ?? [])
  return Array.from({ length: options.days }, (_, index) => {
    const date = new Date(options.startDate)
    date.setDate(options.startDate.getDate() + index)
    return buildCalendarDay(date, {
      ...options,
      holidaysByDate,
    })
  })
}
