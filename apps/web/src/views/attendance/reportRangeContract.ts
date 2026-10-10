/** Report export cap. Must match plugins/plugin-attendance/lib/attendance-export-disclosure.cjs */
export const ATTENDANCE_EXPORT_MAX_ROWS = 5000

export interface AttendanceRangeSummary {
  total_days?: number
  total_minutes?: number
  late_days?: number
  early_leave_days?: number
  late_early_days?: number
  partial_days?: number
  absent_days?: number
  adjusted_days?: number
  off_days?: number
}

export interface AttendanceRangeSnapshotMetrics {
  records: number
  flagged: number
  workMinutes: number
}

export interface AttendanceExportDisclosure {
  matchedTotal: number | null
  returned: number | null
  limit: number | null
  truncated: boolean
  status: string
  known: boolean
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Range totals from the summary API. Ignores the visible records page. */
export function attendanceRangeSnapshotMetrics(
  summary: AttendanceRangeSummary | null | undefined,
): AttendanceRangeSnapshotMetrics {
  if (!summary) return { records: 0, flagged: 0, workMinutes: 0 }
  const flagged = finiteNumber(summary.late_days)
    + finiteNumber(summary.early_leave_days)
    + finiteNumber(summary.late_early_days)
    + finiteNumber(summary.partial_days)
    + finiteNumber(summary.absent_days)
    + finiteNumber(summary.adjusted_days)
  return {
    records: finiteNumber(summary.total_days) + finiteNumber(summary.off_days),
    flagged,
    workMinutes: finiteNumber(summary.total_minutes),
  }
}

/** Ask for the loaded range, never more than the server cap. Unknown totals ask for the cap. */
export function resolveReportExportLimit(
  recordsTotal: number,
  max: number = ATTENDANCE_EXPORT_MAX_ROWS,
): number {
  const total = Number(recordsTotal)
  if (!Number.isFinite(total) || total <= 0) return max
  return Math.min(Math.trunc(total), max)
}

/** Record-status pill. `all` stays off the query so the export is the whole range. */
export function reportExportStatusParam(recordStatusFilter: string | null | undefined): string | undefined {
  const status = String(recordStatusFilter ?? '').trim()
  if (!status || status === 'all') return undefined
  return status
}

export function readAttendanceExportDisclosure(
  headers: { get(name: string): string | null },
): AttendanceExportDisclosure {
  const readNumber = (name: string): number | null => {
    const raw = headers.get(name)
    if (raw == null || raw.trim() === '') return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  const truncatedRaw = headers.get('x-attendance-export-truncated')
  return {
    matchedTotal: readNumber('x-attendance-export-total'),
    returned: readNumber('x-attendance-export-returned'),
    limit: readNumber('x-attendance-export-limit'),
    truncated: truncatedRaw === 'true',
    status: headers.get('x-attendance-export-status') || 'all',
    known: truncatedRaw === 'true' || truncatedRaw === 'false',
  }
}
