import { formatAttendanceDateKey } from './attendanceDateTimePresentation'

export type AttendanceReportRangePreset = 'this-week' | 'this-month' | 'last-month' | 'this-quarter'
export type AttendanceReportCalendarRange = { from: string; to: string }

export function buildAttendanceReportCalendarRange(
  period: AttendanceReportRangePreset | 'recent',
  now: Date,
  timeZone: string | null,
): AttendanceReportCalendarRange | null {
  const today = formatAttendanceDateKey(now, timeZone)
  if (!today) return null
  // These Date objects carry civil dates only. UTC arithmetic never applies
  // the browser zone or subtracts elapsed hours across a DST boundary.
  const start = new Date(`${today}T00:00:00Z`)
  const end = new Date(start)
  switch (period) {
    case 'recent':
      start.setUTCDate(start.getUTCDate() - 30)
      break
    case 'this-week':
      start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7)
      end.setTime(start.getTime())
      end.setUTCDate(end.getUTCDate() + 6)
      break
    case 'this-month':
      start.setUTCDate(1)
      end.setUTCMonth(end.getUTCMonth() + 1, 0)
      break
    case 'last-month':
      start.setUTCMonth(start.getUTCMonth() - 1, 1)
      end.setUTCDate(0)
      break
    case 'this-quarter':
      start.setUTCMonth(Math.floor(start.getUTCMonth() / 3) * 3, 1)
      end.setUTCMonth(start.getUTCMonth() + 3, 0)
      break
    default:
      return null
  }
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) }
}
