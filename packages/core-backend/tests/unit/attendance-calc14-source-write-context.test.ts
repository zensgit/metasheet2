import { describe, expect, it } from 'vitest'
import {
  AttendanceCalc14SourceWriteError,
  assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1,
  attendanceCalc14SourceWriteErrorV1,
} from '../../src/attendance/attendance-calc14-source-write-context'

const PG_POLICIES = [
  ['ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED', 422],
  ['ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT', 409],
  ['ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID', 403],
  ['ATTENDANCE_CALC14_SOURCE_IMMUTABLE', 409],
] as const
const TYPED_ONLY_POLICIES = [
  ['ATTENDANCE_CALC14_EFFECTIVE_DATE_INVALID', 422],
  ['ATTENDANCE_CALC14_HISTORICAL_AUTHORIZATION_REQUIRED', 403],
  ['ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE', 422],
] as const
const TYPED_POLICIES = [...PG_POLICIES, ...TYPED_ONLY_POLICIES]
const UNTRUSTED = 'fixture-secret-placeholder'

function expectFixedEnvelope(input: unknown, code: string, status: number) {
  const mapped = attendanceCalc14SourceWriteErrorV1(input)
  expect(mapped).toBeInstanceOf(AttendanceCalc14SourceWriteError)
  expect(mapped).not.toBe(input)
  expect({ status: mapped?.status, code: mapped?.code, message: mapped?.message })
    .toEqual({ status, code, message: code })
  expect(Object.keys(mapped!).sort()).toEqual(['code', 'name', 'status'])
}

describe('CALC14 source-write mapper closed contract', () => {
  it.each(TYPED_POLICIES)('rebuilds the legitimate typed %s / %s envelope', (code, status) => {
    const input = Object.assign(new AttendanceCalc14SourceWriteError(status, code), {
      detail: UNTRUSTED,
      cause: new Error(UNTRUSTED),
    })
    expectFixedEnvelope(input, code, status)
  })

  it.each([UNTRUSTED, 'ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID '])('rejects an arbitrary typed code %#', (code) => {
    expect(attendanceCalc14SourceWriteErrorV1(new AttendanceCalc14SourceWriteError(500, code))).toBeNull()
  })

  it.each(TYPED_POLICIES)('rejects a changed typed message for %s', (code, status) => {
    const error = new AttendanceCalc14SourceWriteError(status, code)
    error.message = UNTRUSTED
    expect(attendanceCalc14SourceWriteErrorV1(error)).toBeNull()
  })

  it.each(TYPED_POLICIES)('rejects a forged typed 5xx status for %s', (code) => {
    expect(attendanceCalc14SourceWriteErrorV1(new AttendanceCalc14SourceWriteError(500, code))).toBeNull()
  })

  it('rejects an incorrect non-5xx typed status too', () => {
    expect(attendanceCalc14SourceWriteErrorV1(
      new AttendanceCalc14SourceWriteError(422, 'ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID'),
    )).toBeNull()
  })

  it.each(PG_POLICIES)('maps the exact PG-23514 %s / %s envelope', (code, status) => {
    expectFixedEnvelope({ code: '23514', message: code, detail: UNTRUSTED }, code, status)
  })

  it.each(PG_POLICIES)('rejects an extended PG message for %s', (code) => {
    expect(attendanceCalc14SourceWriteErrorV1({ code: '23514', message: code + ' ' + UNTRUSTED })).toBeNull()
  })

  it.each(PG_POLICIES)('requires the exact SQLSTATE even for %s', (code) => {
    expect(attendanceCalc14SourceWriteErrorV1({ code: '28P01', message: code })).toBeNull()
  })

  it.each(TYPED_ONLY_POLICIES)('does not admit typed-only %s through PG-23514', (code) => {
    expect(attendanceCalc14SourceWriteErrorV1({ code: '23514', message: code })).toBeNull()
  })

  it.each([
    null,
    undefined,
    new Error(UNTRUSTED),
    { code: '23514', message: UNTRUSTED },
    { code: '23514', message: ' ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID' },
    { code: '23514', message: 'attendance_calc14_source_scope_invalid' },
    { code: '23514', message: '__proto__' },
    { code: '23514', message: 'constructor' },
    { code: '23514', message: 'toString' },
    { code: '23514', message: null },
    { code: '23514', message: ['ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID'] },
    { code: '23514', message: { toString: () => 'ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID' } },
    { code: 23514, message: 'ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID' },
  ])('leaves unrelated or non-string input to existing generic failure handling %#', (error) => {
    expect(attendanceCalc14SourceWriteErrorV1(error)).toBeNull()
  })
})

describe('CALC14 ordinary business-date authorization retains its public errors', () => {
  it.each([
    [undefined, '2026-10-31', 'ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED', 422],
    ['2026-02-30', '2026-10-31', 'ATTENDANCE_CALC14_EFFECTIVE_DATE_INVALID', 422],
    ['2026-10-31', 'invalid', 'ATTENDANCE_CALC14_EFFECTIVE_DATE_INVALID', 422],
    ['2026-10-30', '2026-10-31', 'ATTENDANCE_CALC14_HISTORICAL_AUTHORIZATION_REQUIRED', 403],
  ] as const)('retains %s / %s -> %s / %s', (value, today, code, status) => {
    let caught: unknown
    try {
      assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1(value, today)
    } catch (error) {
      caught = error
    }
    expectFixedEnvelope(caught, code, status)
  })

  it.each(['2026-10-31', '2026-11-01'])('still accepts an ordinary current/future effective date %s', (value) => {
    expect(assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1(value, '2026-10-31')).toBe(value)
  })
})
