import { describe, expect, it } from 'vitest'
import {
  RECORD_REPORT_DEFAULT_VISIBLE_CODES,
  loadRecordReportColumnPrefs,
  resetRecordReportColumns,
  resolveVisibleRecordReportCodes,
  toggleRecordReportColumn,
} from '../src/views/attendance/recordReportColumnVisibility'

const catalog = [
  'work_date',
  'employee_name',
  'department',
  'expected_attendance_days',
  'punch_times',
  'attendance_result',
]

describe('record report column visibility', () => {
  it('defaults to the calm subset and keeps date and name pinned', () => {
    const visible = resolveVisibleRecordReportCodes(catalog, loadRecordReportColumnPrefs(null))
    expect(visible).toEqual(['work_date', 'employee_name', 'department', 'punch_times', 'attendance_result'])
    expect(visible).not.toContain('expected_attendance_days')
    expect(RECORD_REPORT_DEFAULT_VISIBLE_CODES).toContain('work_date')
    const hidden = toggleRecordReportColumn(catalog, resetRecordReportColumns(), 'work_date', false)
    expect(resolveVisibleRecordReportCodes(catalog, hidden)).toContain('work_date')
  })

  it('remembers a custom subset', () => {
    const storage = new Map<string, string>()
    const memory = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    }
    const custom = toggleRecordReportColumn(catalog, resetRecordReportColumns(), 'expected_attendance_days', true)
    memory.setItem('metasheet_attendance_report_record_columns', JSON.stringify(custom))
    expect(resolveVisibleRecordReportCodes(catalog, loadRecordReportColumnPrefs(memory))).toContain('expected_attendance_days')
  })
})
