export interface CalendarVisibleRange {
  from: string
  to: string
}

interface DateTimeLabelOptions {
  locale: string
  timeZone?: string
}

interface LunarLabelOptions {
  enabled: boolean
  timeZone?: string
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

export function compareDateKeys(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

export function getCalendarVisibleRange(calendarMonth: Date): CalendarVisibleRange {
  const monthStart = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1)
  const monthEnd = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0)
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
