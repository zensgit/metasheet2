/**
 * Shared report from/to contract. An empty side is not valid: buildQuery
 * would omit it and the API would fall back to a 30-day window while the
 * UI still labels the range as unset.
 */
export type AttendanceReportDateRangeIssue = 'missing' | 'inverted'

export function attendanceReportDateRangeIssue(
  from: string,
  to: string,
): AttendanceReportDateRangeIssue | null {
  const normalizedFrom = from.trim()
  const normalizedTo = to.trim()
  if (!normalizedFrom || !normalizedTo) return 'missing'
  if (normalizedFrom > normalizedTo) return 'inverted'
  return null
}

export function isAttendanceReportDateRangeValid(from: string, to: string): boolean {
  return attendanceReportDateRangeIssue(from, to) === null
}
