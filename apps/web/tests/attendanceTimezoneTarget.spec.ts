import { describe, expect, it } from 'vitest'
import {
  parseAttendanceTimezoneTarget,
  resolveTargetRequestInstant,
} from '../src/views/attendance/attendanceTimezoneTarget'

const expected = { orgId: 'org-1', userId: 'user-1', workDate: '2026-11-01' }
const target = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  data: {
    ...expected,
    timezone: 'America/New_York',
    contextFingerprint: 'a'.repeat(64),
    frozen: true,
    referenceId: 'ref-1',
    provenance: { source: 'frozen' },
    window: { startAt: '2026-11-01T04:00:00Z', endAt: '2026-11-02T05:00:00Z' },
    rule: { kind: 'fixed' },
    isWorkingDay: true,
    ...overrides,
  },
})

describe('parseAttendanceTimezoneTarget', () => {
  it.each(['Asia/Singapore', 'Asia/Tokyo', 'UTC'])('accepts a valid target zone %s', timezone => {
    expect(parseAttendanceTimezoneTarget({
      ...target(),
      data: { ...target().data, timezone, provenance: null, referenceId: null, frozen: false },
    }, expected)?.timezone).toBe(timezone)
  })

  it.each([
    [{ orgId: 'org-2' }, 'org binding'],
    [{ userId: 'user-2' }, 'user binding'],
    [{ workDate: '2026-10-31' }, 'work date binding'],
    [{ timezone: 'Not/AZone' }, 'unknown timezone'],
    [{ contextFingerprint: 'a'.repeat(63) }, 'short fingerprint'],
    [{ frozen: 1 }, 'non-boolean frozen'],
    [{ provenance: [] }, 'array provenance'],
    [{ rule: null }, 'missing rule'],
    [{ window: { startAt: '2026-02-30T00:00:00Z', endAt: '2026-03-01T00:00:00Z' } }, 'invalid calendar date'],
    [{ window: { startAt: '2026-01-01T00:00:00+24:00', endAt: '2026-01-02T00:00:00Z' } }, 'offset hour boundary'],
    [{ window: { startAt: '2026-01-01T00:00:00-00:00', endAt: '2026-01-02T00:00:00Z' } }, 'unknown offset'],
    [{ window: { startAt: '2026-01-01T00:00:00Z', endAt: '2026-01-01T00:00:00Z' } }, 'empty window'],
  ])('rejects %s (%s)', (overrides) => {
    expect(parseAttendanceTimezoneTarget(target(overrides), expected)).toBeNull()
  })

  it('rejects a failed envelope and unexpected keys without exposing input values', () => {
    expect(parseAttendanceTimezoneTarget({ ok: false, data: target().data }, expected)).toBeNull()
    expect(parseAttendanceTimezoneTarget({ ...target(), debug: 'private' }, expected)).toBeNull()
  })

  it('accepts legacy frozen provenance as null', () => {
    expect(parseAttendanceTimezoneTarget(target({ provenance: null }), expected)?.provenance).toBeNull()
  })
})

describe('resolveTargetRequestInstant', () => {
  it('resolves unique target wall times in Singapore, Tokyo, and UTC', () => {
    expect(resolveTargetRequestInstant('2026-01-02T09:00', 'Asia/Singapore')).toBe('2026-01-02T01:00:00.000Z')
    expect(resolveTargetRequestInstant('2026-01-02T09:00', 'Asia/Tokyo')).toBe('2026-01-02T00:00:00.000Z')
    expect(resolveTargetRequestInstant('2026-01-02T09:00', 'UTC')).toBe('2026-01-02T09:00:00.000Z')
  })

  it('rejects DST gaps and invalid wall times', () => {
    expect(resolveTargetRequestInstant('2026-03-08T02:30', 'America/New_York')).toBeNull()
    expect(resolveTargetRequestInstant('2026-02-30T09:00', 'Asia/Tokyo')).toBeNull()
  })

  it('requires an explicit matching choice for a fold unless the original instant still matches', () => {
    expect(resolveTargetRequestInstant('2026-11-01T01:30', 'America/New_York')).toBeNull()
    expect(resolveTargetRequestInstant(
      '2026-11-01T01:30:12.345', 'America/New_York', undefined, '2026-11-01T06:30:12.345Z',
    )).toBe('2026-11-01T06:30:12.345Z')
    expect(resolveTargetRequestInstant(
      '2026-11-01T01:30:12.345', 'America/New_York', '2026-11-01T05:30:12.345Z',
      '2026-11-01T06:30:12.345Z',
    )).toBe('2026-11-01T05:30:12.345Z')
  })

  it('preserves an unchanged unique original to millisecond precision and rejects stale originals', () => {
    expect(resolveTargetRequestInstant(
      '2026-01-02T09:00', 'Asia/Singapore', undefined, '2026-01-02T01:00:12.345Z',
    )).toBe('2026-01-02T01:00:12.345Z')
    expect(resolveTargetRequestInstant(
      '2026-01-02T09:01', 'Asia/Singapore', undefined, '2026-01-02T01:00:12.345Z',
    )).toBe('2026-01-02T01:01:00.000Z')
  })

  it('rejects a selected fold instant that is not one of the choices', () => {
    expect(resolveTargetRequestInstant(
      '2026-11-01T01:30', 'America/New_York', '2026-11-01T07:30:00Z',
    )).toBeNull()
  })
})
