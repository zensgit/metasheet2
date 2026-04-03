export const ATTENDANCE_REPORT_ALL_FILTER = 'all'

export interface AttendanceReportRequestRow {
  requestType: string
  status: string
  total: number
  minutes: number
}

export interface AttendanceReportRecordRow {
  status: string
}

export interface AttendanceReportFilterOption {
  value: string
  count: number
}

export interface AttendanceReportSummary {
  pendingRequests: number
  approvedRequests: number
  approvedMinutes: number
  followUpRecords: number
}

function normalizeKey(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase()
}

function toSafeNumber(value: unknown): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

function buildOptions(values: string[], counts: Map<string, number>): AttendanceReportFilterOption[] {
  return values.map((value) => ({
    value,
    count: counts.get(value) ?? 0,
  }))
}

export function buildAttendanceRequestTypeOptions(
  rows: AttendanceReportRequestRow[],
): AttendanceReportFilterOption[] {
  const order: string[] = []
  const counts = new Map<string, number>()

  rows.forEach((row) => {
    const value = String(row.requestType || '').trim()
    if (!value) return
    if (!counts.has(value)) order.push(value)
    counts.set(value, (counts.get(value) ?? 0) + toSafeNumber(row.total))
  })

  return buildOptions(order, counts)
}

export function buildAttendanceRequestStatusOptions(
  rows: AttendanceReportRequestRow[],
): AttendanceReportFilterOption[] {
  const order: string[] = []
  const counts = new Map<string, number>()

  rows.forEach((row) => {
    const value = String(row.status || '').trim()
    if (!value) return
    if (!counts.has(value)) order.push(value)
    counts.set(value, (counts.get(value) ?? 0) + toSafeNumber(row.total))
  })

  return buildOptions(order, counts)
}

export function buildAttendanceRecordStatusOptions(
  records: AttendanceReportRecordRow[],
): AttendanceReportFilterOption[] {
  const order: string[] = []
  const counts = new Map<string, number>()

  records.forEach((record) => {
    const value = String(record.status || '').trim()
    if (!value) return
    if (!counts.has(value)) order.push(value)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  })

  return buildOptions(order, counts)
}

export function resolveAttendanceReportFilter(
  selected: string,
  options: AttendanceReportFilterOption[],
): string {
  const normalized = normalizeKey(selected)
  if (!normalized || normalized === ATTENDANCE_REPORT_ALL_FILTER) {
    return ATTENDANCE_REPORT_ALL_FILTER
  }
  return options.some((option) => option.value === selected)
    ? selected
    : ATTENDANCE_REPORT_ALL_FILTER
}

export function filterAttendanceRequestReport(
  rows: AttendanceReportRequestRow[],
  requestTypeFilter: string,
  requestStatusFilter: string,
): AttendanceReportRequestRow[] {
  const nextTypeFilter = normalizeKey(requestTypeFilter)
  const nextStatusFilter = normalizeKey(requestStatusFilter)

  return rows.filter((row) => {
    if (nextTypeFilter && nextTypeFilter !== ATTENDANCE_REPORT_ALL_FILTER && normalizeKey(row.requestType) !== nextTypeFilter) {
      return false
    }
    if (nextStatusFilter && nextStatusFilter !== ATTENDANCE_REPORT_ALL_FILTER && normalizeKey(row.status) !== nextStatusFilter) {
      return false
    }
    return true
  })
}

export function filterAttendanceRecords<T extends AttendanceReportRecordRow>(
  records: T[],
  recordStatusFilter: string,
): T[] {
  const nextStatusFilter = normalizeKey(recordStatusFilter)
  if (!nextStatusFilter || nextStatusFilter === ATTENDANCE_REPORT_ALL_FILTER) {
    return records
  }

  return records.filter((record) => normalizeKey(record.status) === nextStatusFilter)
}

export function isAttendanceFollowUpStatus(status: string | null | undefined): boolean {
  const normalized = normalizeKey(status)
  if (!normalized) return false
  return normalized !== 'normal' && normalized !== 'off'
}

export function summarizeAttendanceReportSurface(
  rows: AttendanceReportRequestRow[],
  records: AttendanceReportRecordRow[],
): AttendanceReportSummary {
  return {
    pendingRequests: rows.reduce((sum, row) => (
      normalizeKey(row.status) === 'pending' ? sum + toSafeNumber(row.total) : sum
    ), 0),
    approvedRequests: rows.reduce((sum, row) => (
      normalizeKey(row.status) === 'approved' ? sum + toSafeNumber(row.total) : sum
    ), 0),
    approvedMinutes: rows.reduce((sum, row) => (
      normalizeKey(row.status) === 'approved' ? sum + toSafeNumber(row.minutes) : sum
    ), 0),
    followUpRecords: records.reduce((sum, record) => (
      isAttendanceFollowUpStatus(record.status) ? sum + 1 : sum
    ), 0),
  }
}
