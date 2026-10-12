import {createRequire} from 'node:module'
import {describe,expect,it} from 'vitest'
const require = createRequire(import.meta.url)
const {validateAttendanceRelatedAbsoluteInstantsV1: validate} = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-request-instants.cjs')
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
