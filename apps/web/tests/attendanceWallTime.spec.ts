import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAttendanceWallTime as resolve } from '../src/views/attendance/attendanceWallTime'

afterEach(() => { vi.unstubAllEnvs() })

describe('explicit attendance wall-time conversion', () => {
  it.each(['Asia/Tokyo', 'America/Los_Angeles', 'UTC'])('ignores viewer timezone %s', viewer => {
    vi.stubEnv('TZ', viewer)
    expect(resolve('2026-10-12T09:00', 'Asia/Singapore')).toEqual({
      kind: 'unique', choices: [{ instant: '2026-10-12T01:00:00.000Z', offsetLabel: 'UTC+08:00' }],
    })
  })
  it('resolves Tokyo independently from Singapore', () => {
    expect(resolve('2026-10-12T09:00', 'Asia/Tokyo')).toEqual({
      kind: 'unique', choices: [{ instant: '2026-10-12T00:00:00.000Z', offsetLabel: 'UTC+09:00' }],
    })
  })
  it('returns both fold choices rather than selecting one', () => {
    expect(resolve('2026-11-01T01:30', 'America/New_York')).toEqual({
      kind: 'fold', choices: [
        { instant: '2026-11-01T05:30:00.000Z', offsetLabel: 'UTC-04:00' },
        { instant: '2026-11-01T06:30:00.000Z', offsetLabel: 'UTC-05:00' },
      ],
    })
  })
  it('rejects a spring gap without shifting it forward', () => {
    expect(resolve('2026-03-08T02:30', 'America/New_York')).toEqual({ kind: 'gap', choices: [] })
  })
  it('handles a thirty-minute fold', () => {
    expect(resolve('2026-04-05T01:45', 'Australia/Lord_Howe')).toEqual({
      kind: 'fold', choices: [
        { instant: '2026-04-04T14:45:00.000Z', offsetLabel: 'UTC+11:00' },
        { instant: '2026-04-04T15:15:00.000Z', offsetLabel: 'UTC+10:30' },
      ],
    })
  })
  it('rejects a date-line skipped day', () => {
    expect(resolve('2011-12-30T12:00', 'Pacific/Apia')).toEqual({ kind: 'gap', choices: [] })
  })
  it('preserves a forty-five-minute offset', () => {
    expect(resolve('2026-10-12T09:00', 'Asia/Kathmandu')).toEqual({
      kind: 'unique', choices: [{ instant: '2026-10-12T03:15:00.000Z', offsetLabel: 'UTC+05:45' }],
    })
  })
  it.each([
    ['2026-02-30T09:00', 'UTC'], ['2026-01-01T24:00', 'UTC'],
    ['2026-01-01T09:00Z', 'UTC'], ['2026-01-01T09:00', '+05:00'],
    ['2026-01-01T09:00', 'invalid-zone'], ['2026-01-01T09:00', ' UTC'],
  ])('rejects invalid input without timezone fallback', (local, zone) => {
    expect(resolve(local, zone)).toEqual({ kind: 'invalid', choices: [] })
  })
})


describe('attendance wall time historical precision', () => {
  it('preserves seconds and milliseconds through the explicit target zone', () => {
    expect(resolve('2026-01-07T09:00:30.123', 'Asia/Singapore')).toEqual({
      kind: 'unique', choices: [{ instant: '2026-01-07T01:00:30.123Z', offsetLabel: 'UTC+08:00' }],
    })
    expect(resolve('2026-01-07T09:00:30.1', 'Asia/Tokyo')).toEqual({
      kind: 'unique', choices: [{ instant: '2026-01-07T00:00:30.100Z', offsetLabel: 'UTC+09:00' }],
    })
  })
  it('retains both repeated instants with the exact historical precision', () => {
    expect(resolve('2026-11-01T01:30:20.456', 'America/New_York')).toEqual({
      kind: 'fold', choices: [
        { instant: '2026-11-01T05:30:20.456Z', offsetLabel: 'UTC-04:00' },
        { instant: '2026-11-01T06:30:20.456Z', offsetLabel: 'UTC-05:00' },
      ],
    })
  })
  it.each(['2026-01-07T09:00:60', '2026-01-07T09:00:30.1234', '2026-01-07T09:00.1'])(
    'rejects malformed precision without normalization: %s', local => {
      expect(resolve(local, 'UTC')).toEqual({ kind: 'invalid', choices: [] })
    },
  )
  it('does not repair a DST gap even when original precision is present', () => {
    expect(resolve('2026-03-08T02:30:20.456', 'America/New_York')).toEqual({ kind: 'gap', choices: [] })
  })
})
