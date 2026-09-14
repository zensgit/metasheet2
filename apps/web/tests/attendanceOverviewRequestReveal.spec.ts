import { createApp, nextTick, reactive, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ATTENDANCE_OVERVIEW_ANOMALIES_SECTION_ID,
  ATTENDANCE_OVERVIEW_REQUEST_REPORT_SECTION_ID,
  ATTENDANCE_OVERVIEW_REQUESTS_SECTION_ID,
  shouldRevealOverviewRequestTools,
} from '../src/views/attendance/attendanceOverviewRequestReveal'
import AttendanceEmployeeOvertimeRequestCard from '../src/views/attendance/AttendanceEmployeeOvertimeRequestCard.vue'
import {
  formatLeaveDurationHours,
  hoursFromLeaveMinutes,
  minutesFromDateTimeRange,
} from '../src/views/attendance/leaveRequestDurationDisplay'
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

describe('overtime-card duration follows start/end (same 0.5-hour helpers)', () => {
  let app: App<Element> | undefined
  let root: HTMLDivElement | undefined
  afterEach(() => { app?.unmount(); root?.remove() })

  function mountCard() {
    const form = reactive({
      overtimeRuleId: 'ot-default',
      workDate: '2026-04-15',
      requestedInAt: '2026-04-15T18:00',
      requestedOutAt: '2026-04-15T20:00',
      minutes: '90',
      reason: 'keep',
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(AttendanceEmployeeOvertimeRequestCard, {
      tr: (en: string) => en,
      requestForm: form,
      overtimeRules: [{ id: 'ot-default', name: 'Standard Overtime' }],
      submitting: false,
    })
    app.mount(root)
    return form
  }

  it.each(['start', 'end'])('clears derived minutes when %s is cleared', async field => {
    const form = mountCard()
    const input = root!.querySelector<HTMLInputElement>(`[data-overtime-card-${field}]`)!
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(form.minutes).toBe('')
    expect(root!.querySelector('[data-overtime-card-duration-value]')!.textContent).toBe('—')
    expect(form.reason).toBe('keep')
  })

  it('snaps a 2.5-hour overtime range to 150 minutes and rejects free-form 2.3 display', async () => {
    const form = mountCard()
    const end = root!.querySelector<HTMLInputElement>('[data-overtime-card-end]')!
    end.value = '2026-04-15T20:30'
    end.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(form.minutes).toBe('150')
    expect(root!.querySelector('[data-overtime-card-duration-value]')!.textContent).toContain('2.5')
    expect(formatLeaveDurationHours(138)).toBe('2.5')
    expect(formatLeaveDurationHours(138)).not.toBe('2.3')
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
