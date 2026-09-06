import { createApp, nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import AttendanceEmployeeWorkspace from '../src/views/attendance/AttendanceEmployeeWorkspace.vue'
import {
  ATTENDANCE_LEAVE_DAY_MINUTES,
  formatLateEarlyPair,
  formatLeaveBalanceMinutes,
  formatWorkDurationMinutes,
  greetingHeadline,
  isClockedIn,
  parseClockHour,
  suggestOffDutyTime,
  workWindowShortLabel,
} from '../src/views/attendance/attendanceEmployeeWorkspacePresentation'
import { buildEmployeeWorkspaceProps } from '../verification/attendance-employee-overview-first-viewport-fixtures'

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
    expect(workWindowShortLabel('09:00–18:00')).toBe('09:00–18:00')
    expect(workWindowShortLabel('—')).toBeNull()
    expect(suggestOffDutyTime('09:00-12:00 / 13:00-18:00 · Asia/Shanghai')).toBe('18:00')
    expect(suggestOffDutyTime('—')).toBeNull()
  })

  it('treats a check-in time as clocked in', () => {
    expect(isClockedIn({ checkIn: '09:18', checkOut: null }, '--:--')).toBe(true)
    expect(isClockedIn({ checkIn: null, checkOut: null }, '09:18')).toBe(true)
    expect(isClockedIn(null, '--:--')).toBe(false)
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
