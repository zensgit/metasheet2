import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_EXPORT_MAX_ROWS,
  attendanceRangeSnapshotMetrics,
  readAttendanceExportDisclosure,
  reportExportStatusParam,
  resolveReportExportLimit,
} from '../src/views/attendance/reportRangeContract'

describe('attendance report range contract', () => {
  it('builds snapshot metrics from the summary range, not a page of rows', () => {
    expect(attendanceRangeSnapshotMetrics(null)).toEqual({ records: 0, flagged: 0, workMinutes: 0 })
    expect(attendanceRangeSnapshotMetrics({
      total_days: 13,
      off_days: 4,
      total_minutes: 5820,
      late_days: 2,
      early_leave_days: 1,
      late_early_days: 3,
      partial_days: 1,
      absent_days: 0,
      adjusted_days: 1,
    })).toEqual({
      records: 17,
      flagged: 8,
      workMinutes: 5820,
    })
  })

  it('requests the loaded range total up to the export cap', () => {
    expect(ATTENDANCE_EXPORT_MAX_ROWS).toBe(5000)
    expect(resolveReportExportLimit(0)).toBe(5000)
    expect(resolveReportExportLimit(1200)).toBe(1200)
    expect(resolveReportExportLimit(8000)).toBe(5000)
    expect(reportExportStatusParam('all')).toBeUndefined()
    expect(reportExportStatusParam(' late ')).toBe('late')
  })

  it('reads export disclosure headers and treats a missing cap flag as unknown', () => {
    const headers = new Headers({
      'X-Attendance-Export-Total': '6200',
      'X-Attendance-Export-Returned': '5000',
      'X-Attendance-Export-Limit': '5000',
      'X-Attendance-Export-Truncated': 'true',
      'X-Attendance-Export-Status': 'late',
    })
    expect(readAttendanceExportDisclosure(headers)).toEqual({
      matchedTotal: 6200,
      returned: 5000,
      limit: 5000,
      truncated: true,
      status: 'late',
      known: true,
    })
    expect(readAttendanceExportDisclosure(new Headers()).known).toBe(false)
    expect(readAttendanceExportDisclosure(new Headers()).truncated).toBe(false)
  })
})
