import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_OVERVIEW_ANOMALIES_SECTION_ID,
  ATTENDANCE_OVERVIEW_REQUEST_REPORT_SECTION_ID,
  ATTENDANCE_OVERVIEW_REQUESTS_SECTION_ID,
  shouldRevealOverviewRequestTools,
} from '../src/views/attendance/attendanceOverviewRequestReveal'
import {
  formatLeaveDurationHours,
  hoursFromLeaveMinutes,
  minutesFromDateTimeRange,
} from '../src/views/attendance/leaveRequestDurationDisplay'

describe('shouldRevealOverviewRequestTools', () => {
  it('opens for the 我的申请 deep link without a focused request id', () => {
    expect(shouldRevealOverviewRequestTools(ATTENDANCE_OVERVIEW_REQUESTS_SECTION_ID, '')).toBe(true)
    expect(shouldRevealOverviewRequestTools(ATTENDANCE_OVERVIEW_REQUESTS_SECTION_ID)).toBe(true)
  })

  it('opens for approval-center focused request id even without a section', () => {
    expect(shouldRevealOverviewRequestTools('', 'request-focused')).toBe(true)
    expect(shouldRevealOverviewRequestTools(ATTENDANCE_OVERVIEW_REQUESTS_SECTION_ID, 'request-focused')).toBe(true)
  })

  it('opens for the request-form / anomalies and request-report landings', () => {
    expect(shouldRevealOverviewRequestTools(ATTENDANCE_OVERVIEW_ANOMALIES_SECTION_ID, '')).toBe(true)
    expect(shouldRevealOverviewRequestTools(ATTENDANCE_OVERVIEW_REQUEST_REPORT_SECTION_ID, '')).toBe(true)
  })

  it('stays closed for unrelated overview sections', () => {
    expect(shouldRevealOverviewRequestTools('attendance-overview-records', '')).toBe(false)
    expect(shouldRevealOverviewRequestTools('attendance-overview-decision-trace', '')).toBe(false)
    expect(shouldRevealOverviewRequestTools('', '')).toBe(false)
    expect(shouldRevealOverviewRequestTools(null, '   ')).toBe(false)
  })
})

describe('leave-card duration display (hours follow start/end, 0.5-step)', () => {
  it('treats 8.5 hours as 510 minutes and rejects free-form 8.3 display', () => {
    expect(hoursFromLeaveMinutes(510)).toBe(8.5)
    expect(formatLeaveDurationHours(510)).toBe('8.5')
    expect(formatLeaveDurationHours(480)).toBe('8')
    expect(formatLeaveDurationHours(498)).toBe('8.5')
    expect(formatLeaveDurationHours(498)).not.toBe('8.3')
  })

  it('snaps a datetime range to half-hour minutes without inventing a day length', () => {
    expect(minutesFromDateTimeRange('2026-08-28T09:00', '2026-08-28T17:30')).toBe(510)
    expect(minutesFromDateTimeRange('2026-08-28T09:00', '2026-08-28T18:00')).toBe(540)
  })
})
