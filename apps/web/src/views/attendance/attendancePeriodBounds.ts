import {
  formatAttendanceDateKey,
  normalizeAttendanceTimeZone,
} from './attendanceDateTimePresentation'

export interface AttendanceCalendarDate {
  year: number
  month: number
  day: number
  quarter: number
  dateKey: string
}

export interface ComprehensiveHoursPeriodDefaults {
  year: number
  month: number
  quarter: number
  from: string
  to: string
}

export function attendanceCalendarDate(
  instant: Date,
  timeZone: string | null | undefined,
): AttendanceCalendarDate | null {
  const dateKey = formatAttendanceDateKey(instant, timeZone)
  if (!dateKey) return null
  const [yearText, monthText, dayText] = dateKey.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  return {
    year,
    month,
    day,
    quarter: Math.floor((month - 1) / 3) + 1,
    dateKey,
  }
}

export function attendanceMonthBounds(
  year: number,
  month: number,
): { from: string; to: string } | null {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) return null
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const yyyy = String(year).padStart(4, '0')
  const mm = String(month).padStart(2, '0')
  return {
    from: `${yyyy}-${mm}-01`,
    to: `${yyyy}-${mm}-${String(lastDay).padStart(2, '0')}`,
  }
}

export function comprehensiveHoursDefaultPeriod(
  instant: Date,
  timeZone: string | null | undefined,
): ComprehensiveHoursPeriodDefaults | null {
  const calendar = attendanceCalendarDate(instant, timeZone)
  if (!calendar) return null
  const range = attendanceMonthBounds(calendar.year, calendar.month)
  if (!range) return null
  return {
    year: calendar.year,
    month: calendar.month,
    quarter: calendar.quarter,
    from: range.from,
    to: range.to,
  }
}

export interface PayrollAnchorTemplate {
  id: string
  timezone?: string | null
  isDefault?: boolean
}

/**
 * Zone for the payroll-generate anchor.
 * Selected template, else the default template (else the first), else the attendance rule zone.
 */
export function resolvePayrollAnchorTimeZone(input: {
  templateId?: string | null
  templates: PayrollAnchorTemplate[]
  attendanceTimeZone?: string | null
}): string | null {
  const selectedId = String(input.templateId ?? '').trim()
  const selected = selectedId
    ? input.templates.find(item => item.id === selectedId)
    : input.templates.find(item => item.isDefault) ?? input.templates[0]
  return normalizeAttendanceTimeZone(selected?.timezone)
    ?? normalizeAttendanceTimeZone(input.attendanceTimeZone)
}
