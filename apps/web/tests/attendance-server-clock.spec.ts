import { describe, expect, it } from 'vitest'
import { createAttendanceServerClock } from '../src/views/attendance/attendanceServerClock'
import { formatAttendanceDateKey, formatAttendanceWeekday } from '../src/views/attendance/attendanceDateTimePresentation'

const sample = '2026-04-15T02:00:00.000Z'
describe('Attendance server receive clock', () => {
  it('anchors at receive, includes processing elapsed and never adds half RTT', () => {
    const clock = createAttendanceServerClock()
    expect(clock.now(0)).toBeNull()
    expect(clock.accept(clock.beginSample(), sample, 100, 5_100)).toBe(true)
    expect(clock.now(5_100)?.toISOString()).toBe(sample)
    expect(clock.now(6_100)?.toISOString()).toBe('2026-04-15T02:00:01.000Z')
  })
  it.each([undefined, null, '', 'bad', '2026-02-30T00:00:00.000Z', '2026-04-15', '2026-04-15T02:00:00Z', 1])('refuses invalid/noncanonical sample %s', (value) => {
    const clock = createAttendanceServerClock()
    expect(clock.accept(clock.beginSample(), value, 0, 1)).toBe(false)
    expect(clock.now(1)).toBeNull()
  })
  it.each([[0, 5_001], [2, 1], [-1, 1], [NaN, 1], [0, Infinity]])('refuses invalid RTT %s/%s', (sent, received) => {
    const clock = createAttendanceServerClock()
    expect(clock.accept(clock.beginSample(), sample, sent, received)).toBe(false)
    expect(clock.now(1)).toBeNull()
  })
  it('expires at five minutes and cannot revive after backwards monotonic input', () => {
    const clock = createAttendanceServerClock()
    clock.accept(clock.beginSample(), sample, 0, 10)
    expect(clock.now(300_009)).not.toBeNull()
    expect(clock.now(300_010)).toBeNull()
    expect(clock.now(11)).toBeNull()
    clock.accept(clock.beginSample(), sample, 0, 10)
    expect(clock.now(9)).toBeNull()
    expect(clock.now(11)).toBeNull()
  })
  it('rejects an older success/failure even before the newer response arrives', () => {
    const clock = createAttendanceServerClock()
    const first = clock.beginSample()
    const second = clock.beginSample()
    expect(clock.accept(first, sample, 0, 10)).toBe(false)
    clock.accept(second, sample, 0, 20)
    clock.fail(first)
    expect(clock.now(20)?.toISOString()).toBe(sample)
    clock.fail(second)
    expect(clock.now(20)).toBeNull()
  })
  it('invalidation refuses pending samples and invalid monotonic ticks clear the anchor', () => {
    const clock = createAttendanceServerClock()
    const pending = clock.beginSample()
    clock.invalidate()
    expect(clock.accept(pending, sample, 0, 1)).toBe(false)
    clock.accept(clock.beginSample(), sample, 0, 1)
    expect(clock.now(NaN)).toBeNull()
    expect(clock.now(2)).toBeNull()
  })
  it('nullable and invalid calendar inputs never reach Intl formatting', () => {
    for (const instant of [null, undefined, new Date(NaN)]) {
      expect(formatAttendanceDateKey(instant, 'Asia/Tokyo')).toBeNull()
      expect(formatAttendanceWeekday(instant, 'en', 'Asia/Tokyo')).toBeNull()
    }
  })
})
