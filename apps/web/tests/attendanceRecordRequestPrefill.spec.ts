import { describe, expect, it } from 'vitest'
import { formatRecordRequestTime, readAttendanceRecordRequestPrefill, resolveRecordRequestTime } from '../src/views/attendance/attendanceRecordRequestPrefill'

const draft = {
  principalKey: 'sub:actor-1',
  orgId: 'org-a',
  workDate: '2026-03-28',
  requestType: 'time_correction',
  requestedInAt: '2026-03-28T01:01:37.123Z',
  requestedOutAt: '2026-03-28T10:05:00.000Z',
  inTimeZone: 'Asia/Shanghai',
  outTimeZone: 'Asia/Shanghai',
}

describe('attendance record request prefill', () => {
  it('reads only the selected request fields for the same actor and organization', () => {
    expect(readAttendanceRecordRequestPrefill({ ...draft, unrelated: 'discard' }, 'sub:actor-1', 'org-a')).toEqual(draft)
  })

  it('rejects another actor, organization, or an absent session', () => {
    expect(readAttendanceRecordRequestPrefill(draft, 'sub:actor-2', 'org-a')).toBeNull()
    expect(readAttendanceRecordRequestPrefill(draft, 'sub:actor-1', 'org-b')).toBeNull()
    expect(readAttendanceRecordRequestPrefill(draft, null, 'org-a')).toBeNull()
  })

  it('never serializes an opaque token principal fallback into history', () => {
    expect(readAttendanceRecordRequestPrefill({ ...draft, principalKey: 'token:opaque' }, 'token:opaque', 'org-a')).toBeNull()
  })

  it.each([
    null,
    'draft',
    [],
    { ...draft, workDate: 'not-a-date' },
    { ...draft, workDate: '2026-02-30' },
    { ...draft, workDate: '0000-10-09' },
    { ...draft, inTimeZone: 'Mars/Olympus' },
    { ...draft, outTimeZone: null },
    { ...draft, requestType: 'leave' },
    { ...draft, requestedInAt: '2026-03-28' },
    { ...draft, requestedInAt: '0000-10-09T01:02:03.004Z' },
    { ...draft, requestedOutAt: null },
  ])('rejects malformed history state %#', value => {
    expect(readAttendanceRecordRequestPrefill(value, 'sub:actor-1', 'org-a')).toBeNull()
  })

  it('keeps an absent punch empty instead of fabricating a time', () => {
    const missing = { ...draft, requestType: 'missed_check_out', requestedOutAt: '' }
    expect(readAttendanceRecordRequestPrefill(missing, 'sub:actor-1', 'org-a')).toEqual(missing)
  })
  it('formats historical wall time independently of the browser and preserves original seconds/milliseconds', () => {
    expect(formatRecordRequestTime(draft.requestedInAt, draft.inTimeZone)).toBe('2026-03-28T09:01:37.123')
    expect(resolveRecordRequestTime('2026-03-28T09:01:37.123', draft.requestedInAt, draft.inTimeZone)).toBe(draft.requestedInAt)
    expect(resolveRecordRequestTime('2026-03-28T09:02:38.456', draft.requestedInAt, draft.inTimeZone)).toBe('2026-03-28T01:02:38.456Z')
  })

  it('rejects invalid clocks and DST gaps instead of shifting the requested punch', () => {
    expect(resolveRecordRequestTime('2026-03-08T02:30', '', 'America/New_York')).toBeNull()
    expect(resolveRecordRequestTime('2026-02-30T09:00', '', 'Asia/Shanghai')).toBeNull()
    expect(resolveRecordRequestTime('2026-03-28T25:00', '', 'Asia/Shanghai')).toBeNull()
    expect(resolveRecordRequestTime('0000-10-09T09:00', '', 'Asia/Shanghai')).toBeNull()
  })

  it('keeps the exact later overlap source unless edited, then uses the disclosed earlier-occurrence policy', () => {
    const later = '2026-11-01T06:30:37.123Z'
    expect(resolveRecordRequestTime('2026-11-01T01:30:37.123', later, 'America/New_York')).toBe(later)
    expect(resolveRecordRequestTime('2026-11-01T01:31:38.456', later, 'America/New_York')).toBe('2026-11-01T05:31:38.456Z')
  })

})
