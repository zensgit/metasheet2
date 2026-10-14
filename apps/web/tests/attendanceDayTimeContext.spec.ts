import { describe, expect, it } from 'vitest'
import { attendanceDayTimezoneLabel, parseAttendanceDayTimeContext } from '../src/views/attendance/attendanceDayTimeContext'

const context = {
  targetWorkDate: '2026-04-15', effectiveTimezone: 'Asia/Singapore', timezoneSource: 'trip',
  mode: 'multi_timezone', policyVersion: 2, contextFingerprint: 'a'.repeat(64), frozen: false,
}
describe('per-day attendance timezone context', () => {
  it('binds the complete context to the exact calendar date', () => {
    const parsed = parseAttendanceDayTimeContext(context, '2026-04-15')
    expect(parsed).toEqual(context)
    expect(attendanceDayTimezoneLabel(parsed, false)).toBe('Attendance timezone: Asia/Singapore · Approved business trip')
    expect(parseAttendanceDayTimeContext(context, '2026-04-16')).toBeNull()
  })
  it('preserves legacy history without inventing a fingerprint or revision', () => {
    const legacy = { ...context, timezoneSource: 'legacy_record', mode: null,
      policyVersion: null, contextFingerprint: null, frozen: true }
    expect(parseAttendanceDayTimeContext(legacy, '2026-04-15')).toEqual(legacy)
    expect(attendanceDayTimezoneLabel(parseAttendanceDayTimeContext(legacy, '2026-04-15'), true))
      .toBe('考勤时区：Asia/Singapore · 历史记录（来源版本未知） · 已保存的班次')
  })
  it.each([
    { effectiveTimezone: 'Invalid/Zone' }, { effectiveTimezone: ' Asia/Singapore' },
    { timezoneSource: 'browser' }, { timezoneSource: ['trip'] }, { mode: 'other' },
    { mode: 'default_only' }, { policyVersion: -1 }, { contextFingerprint: null },
    { contextFingerprint: 'bad' }, { frozen: 'true' }, { extra: true },
    { targetWorkDate: '2026-02-30' },
    { timezoneSource: 'legacy_record', mode: null, policyVersion: null, frozen: false },
    { timezoneSource: 'legacy_record', mode: null, policyVersion: 1, frozen: true },
  ])('rejects invalid per-day authority: %j', patch => {
    expect(parseAttendanceDayTimeContext({ ...context, ...patch }, '2026-04-15')).toBeNull()
  })
  it('reports unavailable without substituting a viewer or month timezone', () => {
    expect(attendanceDayTimezoneLabel(null, false)).toBe('Attendance timezone unavailable')
  })
})
