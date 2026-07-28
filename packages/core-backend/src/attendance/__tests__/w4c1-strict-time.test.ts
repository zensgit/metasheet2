/**
 * W4C-1 (#4556) — strict timezone conversion gates (lock 5.1, W4C-R3/R33).
 *
 * Proves: explicit-offset-only instant parsing (offset-less values that would
 * otherwise use server-local time are rejected), strict IANA zone validation
 * (offset "zones" rejected), and gap/unique/fold enumeration against the real
 * tz database (America/New_York and Europe/Berlin 2026 transitions) with the
 * exact frozen instants/offsets. The UTC-fallback mutation (resolving a gap
 * wall time as if it were UTC) fails the gap/fold legs.
 */
import { describe, expect, it } from 'vitest'
import {
  AttendanceW4TimeError,
  attendanceZoneOffsetMinutesAtV1,
  isAttendanceCalendarDateKeyV1,
  isAttendanceWallTimeHHMMV1,
  parseAttendanceInstantMsV1,
  resolveAttendanceLocalWallTimeV1,
  validateAttendanceIanaTimezoneV1,
} from '../w4c1-strict-time'

describe('parseAttendanceInstantMsV1 (strict explicit-offset instants)', () => {
  it('parses Z, positive, negative, and fractional offsets to exact epoch ms', () => {
    expect(parseAttendanceInstantMsV1('2026-07-01T01:00:00Z')).toBe(Date.UTC(2026, 6, 1, 1, 0, 0))
    expect(parseAttendanceInstantMsV1('2026-07-01T09:00:00+08:00')).toBe(
      Date.UTC(2026, 6, 1, 1, 0, 0),
    )
    expect(parseAttendanceInstantMsV1('2026-07-01T04:30:00-05:30')).toBe(
      Date.UTC(2026, 6, 1, 10, 0, 0),
    )
    expect(parseAttendanceInstantMsV1('2026-07-01T01:00:00.123Z')).toBe(
      Date.UTC(2026, 6, 1, 1, 0, 0, 123),
    )
  })

  it.each([
    ['offset-less local time (server-local fallback shape)', '2026-07-01T09:00:00'],
    ['space separator', '2026-07-01 09:00:00Z'],
    ['lowercase z designator', '2026-07-01T09:00:00z'],
    ['lowercase t designator', '2026-07-01t09:00:00Z'],
    ['leading whitespace', ' 2026-07-01T09:00:00Z'],
    ['trailing whitespace', '2026-07-01T09:00:00Z '],
    ['missing seconds', '2026-07-01T09:00Z'],
    ['calendar-invalid date', '2026-02-30T09:00:00Z'],
    ['hour out of range', '2026-07-01T24:00:00Z'],
    ['minute out of range', '2026-07-01T09:60:00Z'],
    ['offset hours beyond +-14', '2026-07-01T09:00:00+15:00'],
    ['offset without colon', '2026-07-01T09:00:00+0800'],
    ['bare date', '2026-07-01'],
    ['empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(() => parseAttendanceInstantMsV1(value)).toThrowError(AttendanceW4TimeError)
    try {
      parseAttendanceInstantMsV1(value)
    } catch (error) {
      expect((error as AttendanceW4TimeError).code).toBe('W4C1_INSTANT_INVALID')
    }
  })

  it('rejects non-string values', () => {
    for (const value of [null, undefined, 1751328000000, new Date(), {}]) {
      expect(() => parseAttendanceInstantMsV1(value)).toThrowError(AttendanceW4TimeError)
    }
  })
})

describe('validateAttendanceIanaTimezoneV1 (strict IANA)', () => {
  it('accepts real IANA identifiers', () => {
    for (const zone of ['Asia/Shanghai', 'America/New_York', 'Europe/Berlin', 'UTC', 'Etc/GMT+8']) {
      expect(validateAttendanceIanaTimezoneV1(zone)).toBe(zone)
    }
  })

  it.each([
    ['pure offset', '+05:00'],
    ['negative pure offset', '-08:00'],
    ['unknown zone', 'America/Not_A_City'],
    ['embedded whitespace', 'Asia/Shang hai'],
    ['leading whitespace', ' Asia/Shanghai'],
    ['empty string', ''],
  ])('rejects %s', (_label, zone) => {
    expect(() => validateAttendanceIanaTimezoneV1(zone)).toThrowError(AttendanceW4TimeError)
    try {
      validateAttendanceIanaTimezoneV1(zone)
    } catch (error) {
      expect((error as AttendanceW4TimeError).code).toBe('W4C1_TIMEZONE_INVALID')
    }
  })

  it('rejects non-string values', () => {
    for (const zone of [null, undefined, 8, {}]) {
      expect(() => validateAttendanceIanaTimezoneV1(zone)).toThrowError(AttendanceW4TimeError)
    }
  })
})

describe('resolveAttendanceLocalWallTimeV1 (lock 5.1 enumeration)', () => {
  it('resolves an unambiguous wall time to exactly one instant with its offset', () => {
    expect(resolveAttendanceLocalWallTimeV1('2026-07-01', '09:00', 0, 'Asia/Shanghai')).toEqual({
      posture: 'unique',
      epochMs: Date.UTC(2026, 6, 1, 1, 0, 0),
      offsetMinutes: 480,
    })
  })

  it('applies dayOffset=1 before resolving (overnight segment ends)', () => {
    expect(resolveAttendanceLocalWallTimeV1('2026-07-01', '06:00', 1, 'Asia/Shanghai')).toEqual({
      posture: 'unique',
      epochMs: Date.UTC(2026, 6, 1, 22, 0, 0),
      offsetMinutes: 480,
    })
  })

  it('classifies the America/New_York 2026-03-08 spring-forward hole as gap (no UTC fallback)', () => {
    // 02:30 local does not exist on 2026-03-08 (02:00 -> 03:00). A UTC-fallback
    // mutation would instead return a fabricated unique instant.
    expect(resolveAttendanceLocalWallTimeV1('2026-03-08', '02:30', 0, 'America/New_York')).toEqual({
      posture: 'gap',
    })
  })

  it('classifies the America/New_York 2026-11-01 repeated hour as fold with exact earlier/later instants', () => {
    // 01:30 local occurs twice: 05:30Z (EDT, -240) then 06:30Z (EST, -300).
    expect(resolveAttendanceLocalWallTimeV1('2026-11-01', '01:30', 0, 'America/New_York')).toEqual({
      posture: 'fold',
      earlier: { epochMs: Date.UTC(2026, 10, 1, 5, 30, 0), offsetMinutes: -240 },
      later: { epochMs: Date.UTC(2026, 10, 1, 6, 30, 0), offsetMinutes: -300 },
    })
  })

  it('classifies the Europe/Berlin 2026-10-25 repeated hour as fold (second real zone)', () => {
    // 02:30 local occurs twice: 00:30Z (CEST, +120) then 01:30Z (CET, +60).
    expect(resolveAttendanceLocalWallTimeV1('2026-10-25', '02:30', 0, 'Europe/Berlin')).toEqual({
      posture: 'fold',
      earlier: { epochMs: Date.UTC(2026, 9, 25, 0, 30, 0), offsetMinutes: 120 },
      later: { epochMs: Date.UTC(2026, 9, 25, 1, 30, 0), offsetMinutes: 60 },
    })
  })

  it('returns invalid for an unknown or offset-form zone instead of falling back to UTC', () => {
    expect(resolveAttendanceLocalWallTimeV1('2026-07-01', '09:00', 0, 'America/Not_A_City')).toEqual(
      { posture: 'invalid' },
    )
    expect(resolveAttendanceLocalWallTimeV1('2026-07-01', '09:00', 0, '+08:00')).toEqual({
      posture: 'invalid',
    })
  })

  it('throws on malformed frozen date/time inputs (they are contract values, not evidence)', () => {
    expect(() =>
      resolveAttendanceLocalWallTimeV1('2026-2-1', '09:00', 0, 'Asia/Shanghai'),
    ).toThrowError(AttendanceW4TimeError)
    expect(() =>
      resolveAttendanceLocalWallTimeV1('2026-02-30', '09:00', 0, 'Asia/Shanghai'),
    ).toThrowError(AttendanceW4TimeError)
    expect(() =>
      resolveAttendanceLocalWallTimeV1('2026-07-01', '24:00', 0, 'Asia/Shanghai'),
    ).toThrowError(AttendanceW4TimeError)
    expect(() =>
      resolveAttendanceLocalWallTimeV1('2026-07-01', '09:00', 2 as unknown as 0, 'Asia/Shanghai'),
    ).toThrowError(AttendanceW4TimeError)
  })
})

describe('supporting guards', () => {
  it('reports exact zone offsets from the tz database', () => {
    expect(attendanceZoneOffsetMinutesAtV1('Asia/Shanghai', Date.UTC(2026, 6, 1))).toBe(480)
    expect(attendanceZoneOffsetMinutesAtV1('America/New_York', Date.UTC(2026, 6, 1))).toBe(-240)
    expect(attendanceZoneOffsetMinutesAtV1('America/New_York', Date.UTC(2026, 0, 15))).toBe(-300)
  })

  it('validates calendar date keys and HH:MM wall times strictly', () => {
    expect(isAttendanceCalendarDateKeyV1('2026-07-01')).toBe(true)
    expect(isAttendanceCalendarDateKeyV1('2026-02-30')).toBe(false)
    expect(isAttendanceCalendarDateKeyV1('2026-7-1')).toBe(false)
    expect(isAttendanceCalendarDateKeyV1(20260701)).toBe(false)
    expect(isAttendanceWallTimeHHMMV1('09:00')).toBe(true)
    expect(isAttendanceWallTimeHHMMV1('23:59')).toBe(true)
    expect(isAttendanceWallTimeHHMMV1('24:00')).toBe(false)
    expect(isAttendanceWallTimeHHMMV1('9:00')).toBe(false)
    expect(isAttendanceWallTimeHHMMV1(900)).toBe(false)
  })
})
