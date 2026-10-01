import { createApp, nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import AttendanceEmployeeWorkspace from '../src/views/attendance/AttendanceEmployeeWorkspace.vue'
import {
  ATTENDANCE_LEAVE_DAY_MINUTES,
  formatLateEarlyPair,
  formatLeaveBalanceMinutes,
  formatSelfServiceWorkWindowSummary,
  formatWorkDurationMinutes,
  greetingHeadline,
  isClockedIn,
  parseClockHour,
  resolveHeroPunchEmphasis,
  resolveTodoMark,
  suggestOffDutyTime,
  workWindowShortLabel,
} from '../src/views/attendance/attendanceEmployeeWorkspacePresentation'
import { buildEmployeeWorkspaceProps } from '../verification/attendance-employee-overview-first-viewport-fixtures'
import {
  formatAttendanceClockTime,
  formatAttendanceDateKey,
  formatAttendanceDateTime,
  formatAttendanceWeekday,
  normalizeAttendanceTimeZone,
} from '../src/views/attendance/attendanceDateTimePresentation'
import { formatTimezoneLabel } from '../src/utils/timezones'

const en = (english: string, _zh: string) => english
const zh = (_english: string, chinese: string) => chinese

describe('attendanceEmployeeWorkspacePresentation', () => {
  it('greets from clock hour only', () => {
    expect(greetingHeadline(zh, '09:18')).toBe('早上好')
    expect(greetingHeadline(en, '09:18:24')).toBe('Good morning')
    expect(greetingHeadline(zh, '12:00')).toBe('下午好')
    expect(greetingHeadline(en, '17:59')).toBe('Good afternoon')
    expect(greetingHeadline(zh, '18:00')).toBe('晚上好')
    expect(greetingHeadline(en, null)).toBe('Good morning')
    expect(parseClockHour('not-a-time')).toBeNull()
  })

  it('formats work minutes as hours+minutes in the view layer', () => {
    expect(formatWorkDurationMinutes(444, zh)).toBe('7小时24分')
    expect(formatWorkDurationMinutes(444, en)).toBe('7h 24m')
    expect(formatWorkDurationMinutes(60, zh)).toBe('1小时')
    expect(formatWorkDurationMinutes(18, en)).toBe('18m')
    expect(formatWorkDurationMinutes(0, zh)).toBe('0分')
    expect(formatWorkDurationMinutes(null, en)).toBe('—')
  })

  it('uses the existing 480-minute leave-day convention for balance display', () => {
    expect(ATTENDANCE_LEAVE_DAY_MINUTES).toBe(480)
    expect(formatLeaveBalanceMinutes(0, zh)).toBe('0天')
    expect(formatLeaveBalanceMinutes(0, en)).toBe('0 days')
    expect(formatLeaveBalanceMinutes(30, zh)).toBe('30分')
    expect(formatLeaveBalanceMinutes(30, en)).toBe('30m')
    expect(formatLeaveBalanceMinutes(120, zh)).toBe('2小时')
    expect(formatLeaveBalanceMinutes(120, en)).toBe('2h')
    expect(formatLeaveBalanceMinutes(480, zh)).toBe('1天')
    expect(formatLeaveBalanceMinutes(480, en)).toBe('1 day')
    expect(formatLeaveBalanceMinutes(490, zh)).toBe('1天 10分')
    expect(formatLeaveBalanceMinutes(490, en)).toBe('1 day 10m')
    expect(formatLeaveBalanceMinutes(600, zh)).toBe('1天 2小时')
    expect(formatLeaveBalanceMinutes(600, en)).toBe('1 day 2h')
    expect(formatLeaveBalanceMinutes(1800, zh)).toBe('3天 6小时')
    expect(formatLeaveBalanceMinutes(1800, en)).toBe('3 days 6h')
    expect(formatLeaveBalanceMinutes(2400, zh)).toBe('5天')
    expect(formatLeaveBalanceMinutes(2400, en)).toBe('5 days')
    expect(formatLeaveBalanceMinutes(null, en)).toBe('—')
    expect(formatLeaveBalanceMinutes(-12, zh)).toBe('—')
    expect(formatLeaveBalanceMinutes(1800, en, 0)).toBe('3 days 6h')
  })

  it('reformats a late/early pair without changing other labels', () => {
    expect(formatLateEarlyPair('18 / 18', zh)).toBe('18分 / 18分')
    expect(formatLateEarlyPair('18 / 18', en)).toBe('18m / 18m')
    expect(formatLateEarlyPair('0 / 0', en)).toBe('0m / 0m')
    expect(formatLateEarlyPair('n/a', en)).toBe('n/a')
  })

  it('reads a work-window label for chrome only', () => {
    expect(workWindowShortLabel('09:00-18:00 · Asia/Shanghai')).toBe('09:00-18:00')
    expect(workWindowShortLabel('09:00-18:00 · UTC+08:00 · Asia/Shanghai')).toBe('09:00-18:00')
    expect(workWindowShortLabel('09:00–18:00')).toBe('09:00–18:00')
    expect(workWindowShortLabel('—')).toBeNull()
    expect(suggestOffDutyTime('09:00-12:00 / 13:00-18:00 · Asia/Shanghai')).toBe('18:00')
    expect(suggestOffDutyTime('09:00-18:00 · UTC+00:00 · UTC')).toBe('18:00')
    expect(suggestOffDutyTime('—')).toBeNull()
  })

  it('prints the work window with the same offset label as overview hints', () => {
    const shanghai = formatSelfServiceWorkWindowSummary({
      workStartTime: '09:00',
      workEndTime: '18:00',
      timezone: 'Asia/Shanghai',
      defaultRuleLabel: 'Default rule',
    })
    const utc = formatSelfServiceWorkWindowSummary({
      workStartTime: '09:00',
      workEndTime: '18:00',
      timezone: 'UTC',
      defaultRuleLabel: 'Default rule',
    })
    expect(shanghai).toBe(`09:00-18:00 · ${formatTimezoneLabel('Asia/Shanghai')}`)
    expect(utc).toBe(`09:00-18:00 · ${formatTimezoneLabel('UTC')}`)
    expect(formatTimezoneLabel('Asia/Shanghai')).toBe('UTC+08:00 · Asia/Shanghai')
    expect(formatTimezoneLabel('UTC')).toBe('UTC+00:00 · UTC')
    expect(shanghai).not.toBe('09:00-18:00 · Asia/Shanghai')
    expect(utc).not.toBe('09:00-18:00 · UTC')
    expect(formatSelfServiceWorkWindowSummary({
      workStartTime: '09:00',
      workEndTime: '18:00',
      timezone: 'Not/AZone',
      defaultRuleLabel: 'Default rule',
    })).toBe('09:00-18:00')
    expect(formatSelfServiceWorkWindowSummary({
      timezone: 'Asia/Shanghai',
      defaultRuleLabel: '默认规则',
    })).toBe(`默认规则 · ${formatTimezoneLabel('Asia/Shanghai')}`)
  })

  it('treats only an open check-in as clocked in', () => {
    expect(isClockedIn({ checkIn: '09:18', checkOut: null })).toBe(true)
    expect(isClockedIn({ checkIn: '09:18', checkOut: '18:02' })).toBe(false)
    expect(isClockedIn({ checkIn: null, checkOut: '18:02' })).toBe(false)
    expect(isClockedIn(null)).toBe(false)
  })

  it('emphasizes the next punch CTA without inventing a third action', () => {
    expect(resolveHeroPunchEmphasis(null)).toBe('check_in')
    expect(resolveHeroPunchEmphasis({ checkIn: null, checkOut: null })).toBe('check_in')
    expect(resolveHeroPunchEmphasis({ checkIn: '09:18', checkOut: null })).toBe('check_out')
    expect(resolveHeroPunchEmphasis({ checkIn: '09:18', checkOut: '18:02' })).toBe('complete')
  })

  it('keeps the makeup 面性 icon on 缺卡 / anomaly rows and varies other todo marks', () => {
    expect(resolveTodoMark('anomaly')).toEqual({ icon: 'clock-plus', tone: 'makeup' })
    expect(resolveTodoMark('punch_failure')).toEqual({ icon: 'clock-plus', tone: 'makeup' })
    expect(resolveTodoMark('request_pending')).toEqual({ icon: 'calendar', tone: 'leave' })
    expect(resolveTodoMark('request_rejected')).toEqual({ icon: 'calendar', tone: 'leave' })
    expect(resolveTodoMark('record_review')).toEqual({ icon: 'pin', tone: 'review' })
    expect(resolveTodoMark('setup_needed')).toEqual({ icon: 'user', tone: 'setup' })
    expect(resolveTodoMark('all_clear')).toEqual({ icon: 'check', tone: 'clear' })
    expect(resolveTodoMark('unknown_status')).toEqual({ icon: 'pin', tone: 'review' })
  })

  it('renders work dates and punch clocks in the resolved attendance rule timezone', () => {
    const instant = new Date('2026-09-10T19:15:49.000Z')
    expect(formatAttendanceDateKey(instant, 'Asia/Shanghai')).toBe('2026-09-11')
    expect(formatAttendanceDateKey(instant, 'America/Los_Angeles')).toBe('2026-09-10')
    expect(formatAttendanceClockTime(instant, 'Asia/Shanghai')).toBe('03:15')
    expect(formatAttendanceClockTime(instant, 'America/Los_Angeles')).toBe('12:15')
  })

  it('refuses to guess browser-local dates or times when the rule timezone is unavailable', () => {
    const instant = new Date('2026-09-10T19:15:49.000Z')
    expect(normalizeAttendanceTimeZone(' Mars/Olympus ')).toBeNull()
    expect(normalizeAttendanceTimeZone('')).toBeNull()
    expect(formatAttendanceDateKey(instant, 'Mars/Olympus')).toBeNull()
    expect(formatAttendanceClockTime(instant, null)).toBeNull()
    expect(formatAttendanceWeekday(instant, 'en-US', 'Mars/Olympus')).toBeNull()
    expect(formatAttendanceDateTime(instant.toISOString(), 'en-US', 'Mars/Olympus')).toBe('--')
  })

  it('renders a completed pair as clocked out with both timestamps', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(AttendanceEmployeeWorkspace, {
      ...buildEmployeeWorkspaceProps('normal'),
      tr: en,
      heroTimeline: { checkIn: '09:18', checkOut: '18:02' },
    })
    app.mount(container)
    await nextTick()

    expect(container.querySelector('.attendance-ew__clock-status')?.textContent).toContain('Clocked out')
    expect(container.querySelector('[data-attendance-clock-state]')?.getAttribute('data-attendance-clock-state')).toBe('complete')
    expect(container.querySelector('[data-attendance-hero-cta="check_in"]')?.getAttribute('data-attendance-hero-next')).toBeNull()
    expect(container.querySelector('[data-attendance-hero-cta="check_out"]')?.getAttribute('data-attendance-hero-next')).toBeNull()
    expect(container.querySelector('[data-attendance-hero-cta="check_in"]')?.classList.contains('attendance__btn--hero')).toBe(true)
    expect(container.querySelector('[data-attendance-hero-cta="check_in"]')?.classList.contains('attendance__btn--primary')).toBe(true)
    expect(container.querySelector('[data-attendance-hero-cta="check_in"]')?.classList.contains('attendance-ew__punch-btn--complete')).toBe(true)
    expect(container.querySelector('[data-attendance-hero-cta="check_out"]')?.classList.contains('attendance-ew__punch-btn--complete')).toBe(true)
    const metricText = container.querySelector('[data-selfservice-card="status"]')?.textContent ?? ''
    expect(metricText).toContain('In09:18')
    expect(metricText).toContain('Out18:02')
    expect(metricText).toContain('Hours')
    expect(metricText).not.toContain("Today's hours")

    app.unmount()
    container.remove()
  })

  it('promotes Check Out as the next CTA after an open check-in', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(AttendanceEmployeeWorkspace, {
      ...buildEmployeeWorkspaceProps('empty'),
      tr: en,
      heroTimeline: { checkIn: '09:18', checkOut: null },
    })
    app.mount(container)
    await nextTick()

    expect(container.querySelector('[data-attendance-hero-cta="check_out"]')?.getAttribute('data-attendance-hero-next')).toBe('true')
    expect(container.querySelector('[data-attendance-hero-cta="check_in"]')?.getAttribute('data-attendance-hero-next')).toBeNull()
    expect(container.querySelector('[data-attendance-hero-cta="check_in"]')?.classList.contains('attendance-ew__punch-btn--rest')).toBe(true)
    expect(container.querySelector('[data-attendance-hero-cta="check_out"]')?.classList.contains('attendance-ew__punch-btn--next')).toBe(true)
    expect(container.querySelector('[data-attendance-clock-state]')?.getAttribute('data-attendance-clock-state')).toBe('check_out')

    app.unmount()
    container.remove()
  })

  it('keeps first-viewport IA: punch next-action, anomaly makeup mark, empty request footer, 常用 after primary', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(AttendanceEmployeeWorkspace, {
      ...buildEmployeeWorkspaceProps('missing'),
      tr: zh,
    })
    app.mount(container)
    await nextTick()

    const primary = container.querySelector('[data-attendance-overview-primary]')
    const common = container.querySelector('[data-selfservice-card="actions"]')
    expect(primary?.contains(container.querySelector('[data-testid="attendance-hero-punch"]')!)).toBe(true)
    expect(primary?.contains(container.querySelector('[data-attendance-overview-attention]')!)).toBe(true)
    expect(primary?.contains(container.querySelector('[data-selfservice-card="requests"]')!)).toBe(true)
    expect(primary?.contains(common)).toBe(false)
    expect(common?.previousElementSibling).toBe(primary)

    const todoMark = container.querySelector('[data-attendance-todo-mark]')
    expect(todoMark?.getAttribute('data-attendance-todo-tone')).toBe('makeup')
    expect(todoMark?.textContent?.trim()).toBe('')
    expect(todoMark?.querySelector('svg')).toBeTruthy()
    expect(container.querySelector('[data-attendance-todo-empty]')).toBeNull()
    expect(container.querySelector('[data-attendance-request-empty]')?.textContent).toContain('暂无待审批')
    expect(container.querySelector('[data-selfservice-action="missing-punch"]')?.querySelector('.attendance-ew__tile-label')?.textContent).toContain('补卡')

    app.unmount()
    container.remove()
  })

  it('renders a calm empty 今日待办 with a check mark, not the makeup icon', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(AttendanceEmployeeWorkspace, {
      ...buildEmployeeWorkspaceProps('normal'),
      tr: zh,
    })
    app.mount(container)
    await nextTick()

    expect(container.querySelector('[data-attendance-todo-empty]')).toBeTruthy()
    expect(container.querySelector('[data-attendance-todo-mark]')?.getAttribute('data-attendance-todo-tone')).toBe('clear')
    expect(container.querySelector('[data-attendance-overview-attention]')?.textContent).toContain('当前已处理完毕')
    expect(container.querySelector('[data-attendance-overview-attention-action]')).toBeNull()

    app.unmount()
    container.remove()
  })
})

describe('employee self-balance card copy', () => {
  async function mountBalanceCard(summary: {
    remainingMinutes: number
    grantedMinutes: number
    exhaustedMinutes: number
    expiredMinutes: number
  } | null, trFn: (en: string, zh: string) => string = zh) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(AttendanceEmployeeWorkspace, {
      ...buildEmployeeWorkspaceProps('normal'),
      tr: trFn,
      annualSelfBalanceSummary: summary,
    })
    app.mount(container)
    await nextTick()
    return {
      container,
      card: container.querySelector('[data-annual-self-balance]'),
      unmount() {
        app.unmount()
        container.remove()
      },
    }
  }

  it('shows remaining / granted / used / expired in days, not raw minutes', async () => {
    const { card, unmount } = await mountBalanceCard({
      remainingMinutes: 1800,
      grantedMinutes: 2400,
      exhaustedMinutes: 600,
      expiredMinutes: 90,
    })
    const text = card?.textContent ?? ''
    expect(card).toBeTruthy()
    expect(text).toContain('3天 6小时')
    expect(text).toContain('剩余')
    expect(text).toContain('已发放 5天')
    expect(text).toContain('已用 1天 2小时')
    expect(text).toContain('已过期 1小时30分')
    expect(text).not.toContain('1800')
    expect(text).not.toContain('2400')
    expect(text).not.toContain('分钟剩余')
    unmount()
  })

  it('shows English day+hour copy on the same card', async () => {
    const { card, unmount } = await mountBalanceCard({
      remainingMinutes: 1800,
      grantedMinutes: 2400,
      exhaustedMinutes: 600,
      expiredMinutes: 90,
    }, en)
    const text = card?.textContent ?? ''
    expect(text).toContain('3 days 6h remaining')
    expect(text).toContain('Granted 5 days')
    expect(text).toContain('Used 1 day 2h')
    expect(text).toContain('Expired 1h 30m')
    expect(text).not.toContain('1800')
    unmount()
  })

  it('keeps a clear zero state when remaining minutes are 0', async () => {
    const { card, unmount } = await mountBalanceCard({
      remainingMinutes: 0,
      grantedMinutes: 0,
      exhaustedMinutes: 0,
      expiredMinutes: 0,
    })
    const text = card?.textContent ?? ''
    expect(text).toContain('0天')
    expect(text).toContain('剩余')
    expect(text).toContain('已发放 0天')
    expect(text).toContain('已用 0天')
    expect(text).toContain('已过期 0天')
    expect(text).not.toContain('分钟剩余')
    unmount()
  })

  it('keeps the empty-copy path when no summary is loaded', async () => {
    const { container, card, unmount } = await mountBalanceCard(null)
    expect(card).toBeNull()
    expect(container.textContent).toContain('暂无年假余额。')
    unmount()
  })
})
