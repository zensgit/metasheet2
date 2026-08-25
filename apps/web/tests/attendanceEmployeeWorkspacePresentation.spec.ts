import { describe, expect, it } from 'vitest'
import {
  formatLateEarlyPair,
  formatWorkDurationMinutes,
  greetingHeadline,
  isClockedIn,
  parseClockHour,
  suggestOffDutyTime,
  workWindowShortLabel,
} from '../src/views/attendance/attendanceEmployeeWorkspacePresentation'

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
