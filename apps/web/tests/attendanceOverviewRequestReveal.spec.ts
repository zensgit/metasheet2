import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_OVERVIEW_ANOMALIES_SECTION_ID,
  ATTENDANCE_OVERVIEW_REQUEST_REPORT_SECTION_ID,
  ATTENDANCE_OVERVIEW_REQUESTS_SECTION_ID,
  shouldRevealOverviewRequestTools,
} from '../src/views/attendance/attendanceOverviewRequestReveal'

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
