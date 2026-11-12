import { describe, expect, it } from 'vitest'
import {
  isStorableTimeZone,
  isWithinQuietHours,
  parseClockMinutes,
  quietHoursProblem,
  type QuietHours,
} from '../../src/notifications/quiet-hours'

// Every instant is fixed: no expectation depends on the current time or on today's offset.
const at = (iso: string) => new Date(iso)
const window = (start: string, end: string, timeZone: string): QuietHours => ({ start, end, timeZone })

describe('quiet hours inside one day', () => {
  const quiet = window('09:00', '17:30', 'Asia/Shanghai')
  it('is a half-open interval: the start is inside, the end is outside', () => {
    // Shanghai is UTC+8 with no daylight saving.
    expect(isWithinQuietHours(at('2026-03-10T00:59:00Z'), quiet)).toBe(false)
    expect(isWithinQuietHours(at('2026-03-10T01:00:00Z'), quiet)).toBe(true)
    expect(isWithinQuietHours(at('2026-03-10T09:29:00Z'), quiet)).toBe(true)
    expect(isWithinQuietHours(at('2026-03-10T09:30:00Z'), quiet)).toBe(false)
  })
})

describe('quiet hours that cross midnight', () => {
  const quiet = window('22:00', '08:00', 'Asia/Shanghai')
  it('is inside before midnight and after it, and outside by day', () => {
    expect(isWithinQuietHours(at('2026-03-10T13:59:00Z'), quiet)).toBe(false) // 21:59 local
    expect(isWithinQuietHours(at('2026-03-10T14:00:00Z'), quiet)).toBe(true) // 22:00 local
    expect(isWithinQuietHours(at('2026-03-10T16:00:00Z'), quiet)).toBe(true) // 00:00 local
    expect(isWithinQuietHours(at('2026-03-10T23:59:00Z'), quiet)).toBe(true) // 07:59 local
    expect(isWithinQuietHours(at('2026-03-11T00:00:00Z'), quiet)).toBe(false) // 08:00 local
  })
})

describe('time zones', () => {
  it('uses the local clock of the zone, not UTC', () => {
    const quiet = window('08:00', '09:00', 'America/New_York')
    // 2026-01-15 is standard time (UTC-5): 13:30Z is 08:30 local.
    expect(isWithinQuietHours(at('2026-01-15T13:30:00Z'), quiet)).toBe(true)
    expect(isWithinQuietHours(at('2026-01-15T08:30:00Z'), quiet)).toBe(false)
  })

  it('measures a window that straddles the New York spring-forward gap by local clock time only', () => {
    const quiet = window('02:30', '03:30', 'America/New_York')
    // 2026-03-08: at 07:00Z the local clock jumps from 02:00 to 03:00.
    expect(isWithinQuietHours(at('2026-03-08T06:59:00Z'), quiet)).toBe(false) // 01:59 local
    expect(isWithinQuietHours(at('2026-03-08T07:00:00Z'), quiet)).toBe(true) // 03:00 local
    expect(isWithinQuietHours(at('2026-03-08T07:29:00Z'), quiet)).toBe(true) // 03:29 local
    expect(isWithinQuietHours(at('2026-03-08T07:30:00Z'), quiet)).toBe(false) // 03:30 local
  })

  it('treats the gap hour of the spring-forward day as absent and the rest as ordinary', () => {
    const quiet = window('03:00', '04:00', 'America/New_York')
    expect(isWithinQuietHours(at('2026-03-08T06:59:00Z'), quiet)).toBe(false) // 01:59
    expect(isWithinQuietHours(at('2026-03-08T07:00:00Z'), quiet)).toBe(true) // 03:00
    expect(isWithinQuietHours(at('2026-03-08T07:59:00Z'), quiet)).toBe(true) // 03:59
    expect(isWithinQuietHours(at('2026-03-08T08:00:00Z'), quiet)).toBe(false) // 04:00
  })

  it('sees the repeated hour of the New York fall-back day twice (2026-11-01)', () => {
    const quiet = window('01:00', '02:00', 'America/New_York')
    // 05:30Z is 01:30 EDT; 06:30Z is 01:30 EST: both are inside.
    expect(isWithinQuietHours(at('2026-11-01T05:30:00Z'), quiet)).toBe(true)
    expect(isWithinQuietHours(at('2026-11-01T06:30:00Z'), quiet)).toBe(true)
    expect(isWithinQuietHours(at('2026-11-01T07:00:00Z'), quiet)).toBe(false) // 02:00 EST
    expect(isWithinQuietHours(at('2026-11-01T04:59:00Z'), quiet)).toBe(false) // 00:59 EDT
  })

  it('sees the repeated hour of the fall-back day twice (Berlin, 2026-10-25)', () => {
    const quiet = window('02:00', '03:00', 'Europe/Berlin')
    // 00:30Z is 02:30 CEST; 01:30Z is 02:30 CET: both are inside.
    expect(isWithinQuietHours(at('2026-10-25T00:30:00Z'), quiet)).toBe(true)
    expect(isWithinQuietHours(at('2026-10-25T01:30:00Z'), quiet)).toBe(true)
    expect(isWithinQuietHours(at('2026-10-25T02:00:00Z'), quiet)).toBe(false) // 03:00 CET
    expect(isWithinQuietHours(at('2026-10-24T23:59:00Z'), quiet)).toBe(false) // 01:59 CEST
  })

  it('skips the missing hour on the Berlin spring-forward day (2026-03-29)', () => {
    const quiet = window('02:00', '03:00', 'Europe/Berlin')
    // 00:59Z is 01:59 CET; 01:00Z is 03:00 CEST. No instant has a local time in 02:00-02:59.
    for (const iso of ['2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', '2026-03-29T01:30:00Z']) {
      expect(isWithinQuietHours(at(iso), quiet), iso).toBe(false)
    }
  })

  it('accepts an instant as a number', () => {
    expect(isWithinQuietHours(Date.parse('2026-03-10T01:00:00Z'), window('09:00', '10:00', 'Asia/Shanghai'))).toBe(true)
  })
})

describe('validation', () => {
  it('rejects an equal start and end, a malformed clock time and an unknown zone', () => {
    expect(quietHoursProblem({ start: '08:00', end: '08:00', timeZone: 'Asia/Shanghai' })).toBe('window')
    expect(quietHoursProblem({ start: '8:00', end: '09:00', timeZone: 'Asia/Shanghai' })).toBe('start')
    expect(quietHoursProblem({ start: '08:00', end: '24:00', timeZone: 'Asia/Shanghai' })).toBe('end')
    expect(quietHoursProblem({ start: '08:00', end: '09:00', timeZone: 'Not/AZone' })).toBe('timeZone')
    expect(quietHoursProblem({ start: '08:00', end: '09:00', timeZone: ' Asia/Shanghai' })).toBe('timeZone')
    expect(quietHoursProblem({ start: '22:00', end: '08:00', timeZone: 'Asia/Shanghai' })).toBeNull()
  })

  it('throws instead of falling back to UTC for an invalid window', () => {
    expect(() => isWithinQuietHours(0, window('08:00', '08:00', 'Asia/Shanghai'))).toThrow(RangeError)
    expect(() => isWithinQuietHours(0, window('08:00', '09:00', 'Not/AZone'))).toThrow(RangeError)
  })

  it('parses only HH:mm', () => {
    expect(parseClockMinutes('00:00')).toBe(0)
    expect(parseClockMinutes('23:59')).toBe(1439)
    for (const value of ['24:00', '12:60', '1:00', '12:0', '12:00:00', 12, null, undefined]) {
      expect(parseClockMinutes(value), String(value)).toBeNull()
    }
  })

  it('accepts only a time zone that the stored column also accepts', () => {
    expect(isStorableTimeZone('Asia/Shanghai')).toBe(true)
    expect(isStorableTimeZone('Etc/GMT+8')).toBe(true)
    expect(isStorableTimeZone('UTC')).toBe(true)
    expect(isStorableTimeZone('Asia/Shanghai ')).toBe(false)
    expect(isStorableTimeZone('x'.repeat(65))).toBe(false)
    expect(isStorableTimeZone(undefined)).toBe(false)
  })
})
