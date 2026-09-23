import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_CIVIL_DATE_LOOKBACK_DAYS,
  attendanceCivilDateWindow,
  formatAttendanceDateKey,
  shiftAttendanceDateKey,
} from '../src/views/attendance/attendanceDateTimePresentation'

describe('attendance civil date window', () => {
  it('uses the attendance IANA calendar day, not the UTC date from toISOString', () => {
    const eveningInShanghai = new Date('2026-09-10T19:15:49.000Z')
    expect(eveningInShanghai.toISOString().slice(0, 10)).toBe('2026-09-10')
    expect(attendanceCivilDateWindow(eveningInShanghai, 'Asia/Shanghai')).toEqual({
      from: '2026-08-12',
      to: '2026-09-11',
    })
    expect(attendanceCivilDateWindow(eveningInShanghai, 'America/Los_Angeles')).toEqual({
      from: '2026-08-11',
      to: '2026-09-10',
    })
  })

  it('subtracts calendar days across a DST spring-forward, where 24h×N skips a civil day', () => {
    // 2026-03-08 is the US spring-forward. 00:30 PDT is 07:30Z.
    // One 24h step lands on 23:30 PST the previous calendar day (March 7), not March 8.
    const justAfterMidnight = new Date('2026-03-09T07:30:00.000Z')
    expect(formatAttendanceDateKey(justAfterMidnight, 'America/Los_Angeles')).toBe('2026-03-09')
    expect(formatAttendanceDateKey(new Date(justAfterMidnight.getTime() - 86_400_000), 'America/Los_Angeles')).toBe('2026-03-07')
    expect(attendanceCivilDateWindow(justAfterMidnight, 'America/Los_Angeles', 1)).toEqual({
      from: '2026-03-08',
      to: '2026-03-09',
    })
  })

  it('shifts date keys across month and leap-day boundaries', () => {
    expect(ATTENDANCE_CIVIL_DATE_LOOKBACK_DAYS).toBe(30)
    expect(shiftAttendanceDateKey('2024-03-01', -1)).toBe('2024-02-29')
    expect(shiftAttendanceDateKey('2023-03-01', -1)).toBe('2023-02-28')
    expect(shiftAttendanceDateKey('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftAttendanceDateKey('2026-09-11', 0)).toBe('2026-09-11')
  })

  it('returns null instead of a UTC or browser-local day when the zone or key is unusable', () => {
    const instant = new Date('2026-09-11T02:30:00.000Z')
    expect(attendanceCivilDateWindow(instant, null)).toBeNull()
    expect(attendanceCivilDateWindow(instant, '   ')).toBeNull()
    expect(attendanceCivilDateWindow(instant, 'Mars/Olympus')).toBeNull()
    expect(attendanceCivilDateWindow(instant, 'Asia/Shanghai', -1)).toBeNull()
    expect(attendanceCivilDateWindow(instant, 'Asia/Shanghai', 1.5)).toBeNull()
    expect(shiftAttendanceDateKey('2026-02-31', 0)).toBeNull()
    expect(shiftAttendanceDateKey('not-a-date', -1)).toBeNull()
    expect(shiftAttendanceDateKey('2026-09-11', 1.2)).toBeNull()
  })
})
