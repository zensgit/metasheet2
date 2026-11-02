import { describe, expect, it } from 'vitest'
import {
  AttendancePunchDetailInputError,
  parseAttendancePunchDetailInputV1,
} from '../w4c3a-punch-detail-input'

function foldStart() {
  return {
    inputKind: 'punch_events_v1',
    userId: 'synthetic-employee',
    workDate: '2025-11-02',
    timezone: 'America/New_York',
    punches: [
      { direction: 'check_in', occurredAt: '2025-11-02T04:30:00.000Z' },
      { direction: 'check_out', occurredAt: '2025-11-02T04:45:00.000Z' },
      { direction: 'check_in', occurredAt: '2025-11-02T05:30:00.000Z' },
      { direction: 'check_out', occurredAt: '2025-11-02T08:00:00.000Z' },
    ],
  }
}

describe('explicit punch-detail input contract', () => {
  it('retains all four physical fold events and detaches an immutable copy', () => {
    const raw = foldStart()
    const parsed = parseAttendancePunchDetailInputV1(raw)
    expect(parsed).toEqual(raw)
    raw.punches[0].occurredAt = '2000-01-01T00:00:00.000Z'
    expect(parsed.punches[0].occurredAt).toBe('2025-11-02T04:30:00.000Z')
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.punches)).toBe(true)
    expect(parsed.punches.every(Object.isFrozen)).toBe(true)
  })

  it('retains a checkout-only partial without inventing a check-in or a calendar day', () => {
    const raw = { ...foldStart(), workDate: '2025-11-01', punches: [foldStart().punches[3]] }
    expect(parseAttendancePunchDetailInputV1(raw)).toEqual(raw)
  })

  it('retains the six actual events admitted by the existing three-segment bound', () => {
    const raw = foldStart()
    raw.punches.push(
      { direction: 'check_in', occurredAt: '2025-11-02T09:00:00.000Z' },
      { direction: 'check_out', occurredAt: '2025-11-02T10:00:00.000Z' },
    )
    expect(parseAttendancePunchDetailInputV1(raw)).toEqual(raw)
  })

  const invalidInputs: Array<[string, () => unknown]> = [
    ['missing discriminator', () => { const { inputKind: _kind, ...rest } = foldStart(); return rest }],
    ['unknown discriminator', () => ({ ...foldStart(), inputKind: 'daily' })],
    ['numeric discriminator', () => ({ ...foldStart(), inputKind: 1 })],
    ['legacy daily fields', () => ({ workDate: '2025-11-02', fields: { firstInAt: '04:30' } })],
    ['caller minutes', () => ({ ...foldStart(), workMinutes: 165 })],
    ['caller context', () => ({ ...foldStart(), context: {} })],
    ['caller organization', () => ({ ...foldStart(), orgId: 'foreign-org' })],
    ['caller evidence reference', () => ({ ...foldStart(), punches: [{ ...foldStart().punches[0], ref: 'chosen' }] })],
    ['empty user', () => ({ ...foldStart(), userId: '' })],
    ['trimmed user alias', () => ({ ...foldStart(), userId: ' synthetic-employee ' })],
    ['invalid calendar day', () => ({ ...foldStart(), workDate: '2025-02-30' })],
    ['unknown timezone', () => ({ ...foldStart(), timezone: 'Not/A_Timezone' })],
    ['empty events', () => ({ ...foldStart(), punches: [] })],
    ['sparse events', () => ({ ...foldStart(), punches: new Array(2) })],
    ['too many events', () => ({ ...foldStart(), punches: Array.from({ length: 7 }, (_, index) => ({ direction: index % 2 ? 'check_out' : 'check_in', occurredAt: '2025-11-02T' + String(index + 4).padStart(2, '0') + ':00:00.000Z' })) })],
    ['unknown direction', () => ({ ...foldStart(), punches: [{ direction: 'clock', occurredAt: '2025-11-02T04:30:00.000Z' }] })],
    ['ambiguous local instant', () => ({ ...foldStart(), punches: [{ direction: 'check_in', occurredAt: '2025-11-02T01:30:00' }] })],
    ['offset instant instead of explicit UTC', () => ({ ...foldStart(), punches: [{ direction: 'check_in', occurredAt: '2025-11-02T01:30:00.000-04:00' }] })],
    ['normalized impossible instant', () => ({ ...foldStart(), punches: [{ direction: 'check_in', occurredAt: '2025-02-30T04:30:00.000Z' }] })],
    ['same instant', () => ({ ...foldStart(), punches: [foldStart().punches[0], { ...foldStart().punches[1], occurredAt: foldStart().punches[0].occurredAt }] })],
    ['reverse chronology', () => ({ ...foldStart(), punches: foldStart().punches.slice().reverse() })],
    ['repeated direction', () => ({ ...foldStart(), punches: [foldStart().punches[0], foldStart().punches[2]] })],
  ]
  it.each(invalidInputs)('rejects %s with a values-free typed error', (_name, makeInput) => {
    let caught: unknown
    try { parseAttendancePunchDetailInputV1(makeInput()) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(AttendancePunchDetailInputError)
    expect((caught as AttendancePunchDetailInputError).code).toBe('ATTENDANCE_PUNCH_DETAIL_INPUT_INVALID')
    expect((caught as Error).message).toBe('ATTENDANCE_PUNCH_DETAIL_INPUT_INVALID')
  })
})
