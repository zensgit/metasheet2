export function isAttendanceReportDateRangeValid(from: string, to: string): boolean {
  const normalizedFrom = from.trim()
  const normalizedTo = to.trim()

  return !normalizedFrom || !normalizedTo || normalizedFrom <= normalizedTo
}
