import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_OVERVIEW_ANOMALIES_SECTION_ID,
  ATTENDANCE_OVERVIEW_REQUEST_REPORT_SECTION_ID,
  ATTENDANCE_OVERVIEW_REQUESTS_SECTION_ID,
  shouldRevealOverviewRequestTools,
} from '../src/views/attendance/attendanceOverviewRequestReveal'
import {
  firstEligibleMakeupAnomaly,
  formatMakeupAnomalyOptionLabel,
  makeupTimeFieldForRequestType,
  resolveMakeupCardPrefill,
  workDateFromDateTimeLocal,
} from '../src/views/attendance/makeupRequestCardPrefill'

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

describe('makeup-card prefill (skip pending; do not invent types)', () => {
  const zh = (_en: string, chinese: string) => chinese

  it('prefills the first non-pending anomaly and skips pending-only lists', () => {
    const open = {
      recordId: 'record-open',
      workDate: '2026-08-29',
      state: 'open',
      suggestedRequestType: 'missed_check_in',
    }
    const pending = {
      recordId: 'record-pending',
      workDate: '2026-08-28',
      state: 'pending',
      suggestedRequestType: 'missed_check_out',
    }
    expect(firstEligibleMakeupAnomaly([pending, open])).toEqual(open)
    expect(resolveMakeupCardPrefill([pending, open], '2026-08-29')).toEqual({
      workDate: '2026-08-29',
      requestType: 'missed_check_in',
      anomaly: open,
    })
    expect(resolveMakeupCardPrefill([pending], '2026-08-29')).toEqual({
      workDate: '2026-08-29',
      requestType: 'missed_check_in',
      anomaly: null,
    })
    expect(resolveMakeupCardPrefill([], '2026-08-29')).toEqual({
      workDate: '2026-08-29',
      requestType: 'missed_check_in',
      anomaly: null,
    })
  })

  it('labels eligible anomalies without inventing a type, and maps time to the shared form field', () => {
    expect(formatMakeupAnomalyOptionLabel(
      { workDate: '2026-08-29', suggestedRequestType: 'missed_check_in' },
      '2026-08-29',
      zh,
    )).toBe('今天 · 上班缺卡')
    expect(formatMakeupAnomalyOptionLabel(
      { workDate: '2026-08-28', suggestedRequestType: 'missed_check_out' },
      '2026-08-29',
      zh,
    )).toBe('昨天 · 下班缺卡')
    expect(formatMakeupAnomalyOptionLabel(
      { workDate: '2026-08-20', suggestedRequestType: null },
      '2026-08-29',
      zh,
    )).toBe('8月20日 · 时间更正')
    expect(makeupTimeFieldForRequestType('missed_check_in')).toBe('requestedInAt')
    expect(makeupTimeFieldForRequestType('missed_check_out')).toBe('requestedOutAt')
    expect(makeupTimeFieldForRequestType('time_correction')).toBe('requestedInAt')
    expect(workDateFromDateTimeLocal('2026-08-29T09:02')).toBe('2026-08-29')
    expect(workDateFromDateTimeLocal('')).toBeNull()
  })
})
