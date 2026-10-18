import {createRequire} from 'node:module'
import {describe,expect,it} from 'vitest'
const require = createRequire(import.meta.url)
const {validateAttendanceRelatedAbsoluteInstantsV1: validate, validateAttendanceLeaveTargetRangeV1: validateRange} = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-request-instants.cjs')
class HttpError extends Error {
  constructor(readonly status:number,readonly code:string,message:string) {super(message)}
}
describe('related request absolute instant admission',() => {
  it.each(['2026-11-01T01:30','2026-02-30T09:00:00Z','2026-01-12T24:00:00Z','2026-01-12T09:61:00Z','not-a-date',''])('rejects invalid absolute input without echoing values',value => {
    expect(() => validate({requestedInAt:value},HttpError)).toThrowError('ATTENDANCE_TIMEZONE_INSTANT_INVALID')
    try {validate({requestedOutAt:value},HttpError)} catch (error) {
      expect(error).toMatchObject({status:422,code:'ATTENDANCE_TIMEZONE_INSTANT_INVALID',message:'ATTENDANCE_TIMEZONE_INSTANT_INVALID'})
    }
  })
  it.each(['2026-11-01T04:30:00Z','2026-11-01T00:30:00-04:00','2026-11-01T03:30:00-05:00'])('accepts explicit absolute offset input',value => {
    expect(() => validate({requestedInAt:value,requestedOutAt:value},HttpError)).not.toThrow()
  })
  it('allows truly omitted endpoints and checks every supplied alias',() => {
    expect(() => validate({minutes:240,requestedInAt:null},HttpError)).not.toThrow()
    expect(() => validate({requestedInAt:'2026-11-01T04:30:00Z',clockIn:'2026-11-01T00:30'},HttpError)).toThrowError('ATTENDANCE_TIMEZONE_INSTANT_INVALID')
  })
})


const localDate = (instant: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant)
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-')
}
const dayTarget = {
  workDate: '2026-10-19', timezone: 'UTC',
  window: { startAt: '2026-10-19T09:00:00.000Z', endAt: '2026-10-19T18:00:00.000Z' },
}
const nightTarget = {
  ...dayTarget,
  window: { startAt: '2026-10-19T22:00:00.000Z', endAt: '2026-10-20T06:00:00.000Z' },
}
describe('leave interval belongs to one target work date', () => {
  it.each([
    { name: 'minutes only', metadata: { minutes: 240 } },
    { name: 'full-day default', metadata: { minutes: 480, leaveType: { defaultMinutesPerDay: 480 } } },
    { name: 'half-day explicit', metadata: { minutes: 240, leaveType: { defaultMinutesPerDay: 480 } } },
  ])('preserves normalized omitted-endpoint $name quantity policy', ({ metadata }) => {
    const draft = { requestType: 'leave', requestedInAt: null, requestedOutAt: null, metadata }
    const before = structuredClone(draft)
    expect(() => validateRange(draft, dayTarget, HttpError, localDate)).not.toThrow()
    expect(draft).toEqual(before)
  })
  it.each([
    { name: '120-minute interval', start: '2026-10-19T09:00:00Z', end: '2026-10-19T11:00:00Z' },
    { name: 'exclusive midnight endpoint', start: '2026-10-19T00:00:00Z', end: '2026-10-20T00:00:00Z' },
    { name: 'local date differs from UTC date', start: '2026-10-18T16:00:00Z', end: '2026-10-19T16:00:00Z', timezone: 'Asia/Shanghai' },
  ])('allows same-local-workDate $name without changing explicit minutes', ({ start, end, timezone }) => {
    const draft = { requestType: 'leave', requestedInAt: start, requestedOutAt: end, metadata: { minutes: 60 } }
    expect(() => validateRange(draft, { ...dayTarget, timezone: timezone ?? 'UTC' }, HttpError, localDate)).not.toThrow()
    expect(draft).toEqual({ requestType: 'leave', requestedInAt: start, requestedOutAt: end, metadata: { minutes: 60 } })
  })
  it.each([
    { requestedInAt: '2026-10-19T23:59:59Z' },
    { requestedOutAt: '2026-10-20T00:00:00Z' },
  ])('retains a single supplied endpoint with exclusive end semantics %#', endpoints => {
    expect(() => validateRange({ requestType: 'leave', ...endpoints }, dayTarget, HttpError, localDate)).not.toThrow()
  })
  it.each([
    { name: 'UTC night', timezone: 'UTC', workDate: '2026-10-19', start: '2026-10-19T22:00:00Z', end: '2026-10-20T06:00:00Z', minutes: 480 },
    { name: 'spring-forward night', timezone: 'America/New_York', workDate: '2026-03-07', start: '2026-03-08T03:00:00Z', end: '2026-03-08T10:00:00Z', minutes: 420 },
    { name: 'fall-back night', timezone: 'America/New_York', workDate: '2026-10-31', start: '2026-11-01T02:00:00Z', end: '2026-11-01T11:00:00Z', minutes: 540 },
  ])('allows the complete frozen $name window with its real elapsed duration', ({ timezone, workDate, start, end, minutes }) => {
    const target = { timezone, workDate, window: { startAt: start, endAt: end } }
    const draft = { requestType: 'leave', requestedInAt: new Date(start), requestedOutAt: new Date(end) }
    expect((Date.parse(end) - Date.parse(start)) / 60000).toBe(minutes)
    expect(() => validateRange(draft, target, HttpError, localDate)).not.toThrow()
    expect(draft).toEqual({ requestType: 'leave', requestedInAt: new Date(start), requestedOutAt: new Date(end) })
  })
  it.each([
    { name: '33-hour interval', start: '2026-10-19T09:00:00Z', end: '2026-10-20T18:00:00Z', target: dayTarget },
    { name: 'wrong work date', start: '2026-10-18T09:00:00Z', end: '2026-10-18T11:00:00Z', target: dayTarget },
    { name: 'start before night window', start: '2026-10-19T21:59:59.999Z', end: '2026-10-20T06:00:00Z', target: nightTarget },
    { name: 'end after night window', start: '2026-10-19T22:00:00Z', end: '2026-10-20T06:00:00.001Z', target: nightTarget },
    { name: 'reversed interval', start: '2026-10-19T11:00:00Z', end: '2026-10-19T09:00:00Z', target: dayTarget },
    { name: 'empty interval', start: '2026-10-19T09:00:00Z', end: '2026-10-19T09:00:00Z', target: dayTarget },
    { name: 'invalid persisted instant', start: 'not-a-date', end: '2026-10-19T11:00:00Z', target: dayTarget },
    { name: 'wrong-date partial endpoint', start: '2026-10-20T09:00:00Z', end: null, target: dayTarget },
  ])('rejects $name with values-free 409 and leaves the draft untouched', ({ start, end, target }) => {
    const draft = { requestType: 'leave', requestedInAt: start, requestedOutAt: end }
    expect(() => validateRange(draft, target, HttpError, localDate)).toThrowError('ATTENDANCE_TIMEZONE_REQUEST_RANGE_CONFLICT')
    try { validateRange(draft, target, HttpError, localDate) } catch (error) {
      expect(error).toMatchObject({ status: 409, code: 'ATTENDANCE_TIMEZONE_REQUEST_RANGE_CONFLICT', message: 'ATTENDANCE_TIMEZONE_REQUEST_RANGE_CONFLICT' })
    }
    expect(draft).toEqual({ requestType: 'leave', requestedInAt: start, requestedOutAt: end })
  })
  it('does not rewrite overtime range admission', () => {
    expect(() => validateRange({ requestType: 'overtime', requestedInAt: '2026-10-19T09:00:00Z', requestedOutAt: '2026-10-20T18:00:00Z' }, dayTarget, HttpError, localDate)).not.toThrow()
  })
  it('retains the legacy posture when there is no frozen target', () => {
    expect(() => validateRange({ requestType: 'leave', minutes: 240 }, null, HttpError, localDate)).not.toThrow()
  })
})
