export function attendanceReportDateRangeError(from: string, to: string): 'required' | 'invalid' | 'order' | null {
  if (!from.trim() || !to.trim()) return 'required'
  const isDate = (value: string): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const date = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  }
  if (!isDate(from) || !isDate(to)) return 'invalid'
  return from <= to ? null : 'order'
}

export function isAttendanceReportDateRangeValid(from: string, to: string): boolean {
  return attendanceReportDateRangeError(from, to) === null
}
