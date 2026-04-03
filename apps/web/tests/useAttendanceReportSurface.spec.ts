import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_REPORT_ALL_FILTER,
  buildAttendanceRecordStatusOptions,
  buildAttendanceRequestStatusOptions,
  buildAttendanceRequestTypeOptions,
  filterAttendanceRecords,
  filterAttendanceRequestReport,
  resolveAttendanceReportFilter,
  summarizeAttendanceReportSurface,
} from '../src/views/attendance/useAttendanceReportSurface'

describe('useAttendanceReportSurface helpers', () => {
  const requestRows = [
    { requestType: 'leave', status: 'pending', total: 2, minutes: 960 },
    { requestType: 'leave', status: 'approved', total: 1, minutes: 480 },
    { requestType: 'overtime', status: 'approved', total: 3, minutes: 180 },
    { requestType: 'missed_check_in', status: 'rejected', total: 1, minutes: 0 },
  ]

  const records = [
    { status: 'normal' },
    { status: 'late' },
    { status: 'adjusted' },
    { status: 'off' },
  ]

  it('builds stable filter options and falls back invalid selections to all', () => {
    const typeOptions = buildAttendanceRequestTypeOptions(requestRows)
    const statusOptions = buildAttendanceRequestStatusOptions(requestRows)
    const recordOptions = buildAttendanceRecordStatusOptions(records)

    expect(typeOptions).toEqual([
      { value: 'leave', count: 3 },
      { value: 'overtime', count: 3 },
      { value: 'missed_check_in', count: 1 },
    ])

    expect(statusOptions).toEqual([
      { value: 'pending', count: 2 },
      { value: 'approved', count: 4 },
      { value: 'rejected', count: 1 },
    ])

    expect(recordOptions).toEqual([
      { value: 'normal', count: 1 },
      { value: 'late', count: 1 },
      { value: 'adjusted', count: 1 },
      { value: 'off', count: 1 },
    ])

    expect(resolveAttendanceReportFilter('leave', typeOptions)).toBe('leave')
    expect(resolveAttendanceReportFilter('missing', typeOptions)).toBe(ATTENDANCE_REPORT_ALL_FILTER)
    expect(resolveAttendanceReportFilter('', recordOptions)).toBe(ATTENDANCE_REPORT_ALL_FILTER)
  })

  it('filters request rows and records while exposing report summary metrics', () => {
    expect(filterAttendanceRequestReport(requestRows, 'leave', ATTENDANCE_REPORT_ALL_FILTER)).toEqual([
      { requestType: 'leave', status: 'pending', total: 2, minutes: 960 },
      { requestType: 'leave', status: 'approved', total: 1, minutes: 480 },
    ])

    expect(filterAttendanceRequestReport(requestRows, 'leave', 'approved')).toEqual([
      { requestType: 'leave', status: 'approved', total: 1, minutes: 480 },
    ])

    expect(filterAttendanceRecords(records, 'late')).toEqual([{ status: 'late' }])

    expect(summarizeAttendanceReportSurface(requestRows, records)).toEqual({
      pendingRequests: 2,
      approvedRequests: 4,
      approvedMinutes: 660,
      followUpRecords: 2,
    })
  })
})
