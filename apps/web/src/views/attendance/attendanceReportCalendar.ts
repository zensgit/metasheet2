import { normalizeAttendanceTimeZone } from './attendanceDateTimePresentation'

export type AttendanceReportRangePreset = 'this-week' | 'this-month' | 'last-month' | 'this-quarter'

export interface AttendanceCivilDate {
  year: number
  month: number
  day: number
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

const DEFAULT_REPORT_LOOKBACK_DAYS = 30

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatAttendanceCivilDate(date: AttendanceCivilDate): string {
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`
}

function readPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find(part => part.type === type)?.value ?? ''
}

export function attendanceCivilDate(date: Date, timeZone: string | null | undefined): AttendanceCivilDate | null {
  const zone = normalizeAttendanceTimeZone(timeZone)
  if (!zone) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const year = Number(readPart(parts, 'year'))
  const month = Number(readPart(parts, 'month'))
  const day = Number(readPart(parts, 'day'))
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { year, month, day }
}

export function attendanceWeekdayIndex(date: Date, timeZone: string | null | undefined): number | null {
  const zone = normalizeAttendanceTimeZone(timeZone)
  if (!zone) return null
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
  }).format(date).slice(0, 3)
  return Object.prototype.hasOwnProperty.call(WEEKDAY_INDEX, label) ? WEEKDAY_INDEX[label]! : null
}

export function addAttendanceCivilDays(date: AttendanceCivilDate, days: number): AttendanceCivilDate {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day))
  utc.setUTCDate(utc.getUTCDate() + days)
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  }
}

function addAttendanceCivilMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta
  const normalizedYear = Math.floor(index / 12)
  const monthIndex = index - normalizedYear * 12
  return { year: normalizedYear, month: monthIndex + 1 }
}

function firstOfMonth(date: AttendanceCivilDate): AttendanceCivilDate {
  return { year: date.year, month: date.month, day: 1 }
}

function lastOfMonth(date: AttendanceCivilDate): AttendanceCivilDate {
  const next = addAttendanceCivilMonths(date.year, date.month, 1)
  return addAttendanceCivilDays({ year: next.year, month: next.month, day: 1 }, -1)
}

function mondayOfWeek(date: AttendanceCivilDate, weekday: number): AttendanceCivilDate {
  const delta = weekday === 0 ? -6 : 1 - weekday
  return addAttendanceCivilDays(date, delta)
}

export function buildAttendanceReportDefaultRange(
  now: Date,
  timeZone: string | null | undefined,
  lookbackDays = DEFAULT_REPORT_LOOKBACK_DAYS,
): { from: string; to: string } | null {
  const today = attendanceCivilDate(now, timeZone)
  if (!today) return null
  const days = Number.isFinite(lookbackDays) ? Math.max(0, Math.trunc(lookbackDays)) : DEFAULT_REPORT_LOOKBACK_DAYS
  return {
    from: formatAttendanceCivilDate(addAttendanceCivilDays(today, -days)),
    to: formatAttendanceCivilDate(today),
  }
}

export function buildAttendanceReportRangePreset(
  preset: AttendanceReportRangePreset,
  now: Date,
  timeZone: string | null | undefined,
): { from: string; to: string } | null {
  const today = attendanceCivilDate(now, timeZone)
  const weekday = attendanceWeekdayIndex(now, timeZone)
  if (!today || weekday === null) return null

  if (preset === 'this-week') {
    const start = mondayOfWeek(today, weekday)
    return {
      from: formatAttendanceCivilDate(start),
      to: formatAttendanceCivilDate(addAttendanceCivilDays(start, 6)),
    }
  }

  if (preset === 'this-month') {
    return {
      from: formatAttendanceCivilDate(firstOfMonth(today)),
      to: formatAttendanceCivilDate(lastOfMonth(today)),
    }
  }

  if (preset === 'last-month') {
    const previous = addAttendanceCivilMonths(today.year, today.month, -1)
    const start = { year: previous.year, month: previous.month, day: 1 }
    return {
      from: formatAttendanceCivilDate(start),
      to: formatAttendanceCivilDate(lastOfMonth(start)),
    }
  }

  const quarterMonth = Math.floor((today.month - 1) / 3) * 3 + 1
  const start = { year: today.year, month: quarterMonth, day: 1 }
  const quarterEndMonth = addAttendanceCivilMonths(today.year, quarterMonth, 2)
  return {
    from: formatAttendanceCivilDate(start),
    to: formatAttendanceCivilDate(lastOfMonth({ year: quarterEndMonth.year, month: quarterEndMonth.month, day: 1 })),
  }
}
