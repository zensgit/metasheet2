/**
 * W4C-1 (#4556) — pure frozen merge policy gates (lock 4.4: exact branch lift
 * of the legacy `applyAttendanceInOutMergePolicy`; §12.2 "current merge-policy
 * branches" coverage).
 *
 * Every branch of the legacy decision is pinned with exact-shape assertions,
 * including the deliberate asymmetry (earliest INTERNAL check-in vs latest
 * OUTDOOR check-out) and the protected record-only boundary branch.
 */
import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_OUTDOOR_APPROVAL_EVENT_SOURCE_V1,
  AttendanceW4MergePolicyError,
  applyAttendanceInOutMergePolicyPureV1,
  type AttendanceFrozenMergePolicyInputV1,
} from '../w4c1-merge-policy'

const T = (hour: number, minute = 0): number => Date.UTC(2026, 6, 1, hour, minute, 0)
const OUTDOOR = ATTENDANCE_OUTDOOR_APPROVAL_EVENT_SOURCE_V1

function baseInput(
  overrides: Partial<AttendanceFrozenMergePolicyInputV1>,
): AttendanceFrozenMergePolicyInputV1 {
  return {
    internalWinsOnIn: false,
    externalWinsOnOut: false,
    recordFirstInAtMs: null,
    recordLastOutAtMs: null,
    protectedRecordFirstInAtMs: null,
    protectedRecordLastOutAtMs: null,
    events: [],
    ...overrides,
  }
}

describe('applyAttendanceInOutMergePolicyPureV1 (exact legacy branch lift)', () => {
  it('returns the record unchanged when neither policy flag is set', () => {
    expect(
      applyAttendanceInOutMergePolicyPureV1(
        baseInput({
          recordFirstInAtMs: T(0),
          recordLastOutAtMs: T(10),
          events: [
            { eventType: 'check_in', source: OUTDOOR, occurredAtMs: T(0) },
            { eventType: 'check_in', source: 'manual', occurredAtMs: T(1) },
          ],
        }),
      ),
    ).toEqual({ changed: false, nextFirstInAtMs: T(0), nextLastOutAtMs: T(10) })
  })

  it('internalWinsOnIn picks the EARLIEST INTERNAL check-in when internal and outdoor check-ins coexist', () => {
    // Outdoor punched earliest (00:00); internal candidates are 00:30 and 01:00.
    // The legacy branch protects the in side with the earliest INTERNAL punch.
    expect(
      applyAttendanceInOutMergePolicyPureV1(
        baseInput({
          internalWinsOnIn: true,
          recordFirstInAtMs: T(0),
          recordLastOutAtMs: T(10),
          events: [
            { eventType: 'check_in', source: OUTDOOR, occurredAtMs: T(0) },
            { eventType: 'check_in', source: 'manual', occurredAtMs: T(1) },
            { eventType: 'check_in', source: 'manual', occurredAtMs: T(0, 30) },
            { eventType: 'check_out', source: 'manual', occurredAtMs: T(10) },
          ],
        }),
      ),
    ).toEqual({ changed: true, nextFirstInAtMs: T(0, 30), nextLastOutAtMs: T(10) })
  })

  it('internalWinsOnIn does nothing without an outdoor check-in on the day (and no protected value)', () => {
    expect(
      applyAttendanceInOutMergePolicyPureV1(
        baseInput({
          internalWinsOnIn: true,
          recordFirstInAtMs: T(0, 30),
          recordLastOutAtMs: T(10),
          events: [
            { eventType: 'check_in', source: 'manual', occurredAtMs: T(0, 30) },
            { eventType: 'check_out', source: 'manual', occurredAtMs: T(10) },
          ],
        }),
      ),
    ).toEqual({ changed: false, nextFirstInAtMs: T(0, 30), nextLastOutAtMs: T(10) })
  })

  it('internalWinsOnIn does nothing when only outdoor check-ins exist', () => {
    expect(
      applyAttendanceInOutMergePolicyPureV1(
        baseInput({
          internalWinsOnIn: true,
          recordFirstInAtMs: T(0),
          recordLastOutAtMs: null,
          events: [{ eventType: 'check_in', source: OUTDOOR, occurredAtMs: T(0) }],
        }),
      ),
    ).toEqual({ changed: false, nextFirstInAtMs: T(0), nextLastOutAtMs: null })
  })

  it('a protected record-only first-in (import/correction value with no matching event) wins over the earliest internal', () => {
    // The pre-merge record carried 23:30 (previous day, record-only). The
    // current record first-in was overwritten to the outdoor 00:00. The
    // protected branch restores the record-only candidate.
    const protectedMs = Date.UTC(2026, 5, 30, 23, 30, 0)
    expect(
      applyAttendanceInOutMergePolicyPureV1(
        baseInput({
          internalWinsOnIn: true,
          recordFirstInAtMs: T(0),
          recordLastOutAtMs: T(10),
          protectedRecordFirstInAtMs: protectedMs,
          events: [
            { eventType: 'check_in', source: OUTDOOR, occurredAtMs: T(0) },
            { eventType: 'check_in', source: 'manual', occurredAtMs: T(1) },
          ],
        }),
      ),
    ).toEqual({ changed: true, nextFirstInAtMs: protectedMs, nextLastOutAtMs: T(10) })
  })

  it('a protected value represented by an event on that side is NOT protected', () => {
    expect(
      applyAttendanceInOutMergePolicyPureV1(
        baseInput({
          internalWinsOnIn: true,
          recordFirstInAtMs: T(1),
          recordLastOutAtMs: null,
          protectedRecordFirstInAtMs: T(1),
          events: [{ eventType: 'check_in', source: 'manual', occurredAtMs: T(1) }],
        }),
      ),
    ).toEqual({ changed: false, nextFirstInAtMs: T(1), nextLastOutAtMs: null })
  })

  it('represented-by-event un-protection is OBSERVABLE: dropping protection falls back to earliest INTERNAL, not the protected value (gate P2-1)', () => {
    // Gate finding P2-1: the leg above cannot observe its own claim — protected value, record
    // value, and the only event all sit at T(1), so deleting the representedByEvent judgement
    // produces a byte-identical output (changed:false either way). This fixture makes the
    // judgement load-bearing: the protected value T(4) IS represented by an internal event, so
    // protection must drop and the earliest-INTERNAL branch must win with T(2) — NOT keep T(4)
    // (which is what `return previousValueMs` unconditionally would produce), and NOT the
    // outdoor T(0) (internalWinsOnIn). Mirrors legacy protectedRecordTime returning null when
    // the value is event-represented (plugins/plugin-attendance/index.cjs:19303-19308).
    expect(
      applyAttendanceInOutMergePolicyPureV1(
        baseInput({
          internalWinsOnIn: true,
          externalWinsOnOut: false,
          recordFirstInAtMs: T(0),
          recordLastOutAtMs: null,
          protectedRecordFirstInAtMs: T(4),
          protectedRecordLastOutAtMs: null,
          events: [
            { eventType: 'check_in', source: 'outdoor_approval', occurredAtMs: T(0) },
            { eventType: 'check_in', source: 'manual', occurredAtMs: T(2) },
            { eventType: 'check_in', source: 'manual', occurredAtMs: T(4) },
          ],
        }),
      ),
    ).toEqual({ changed: true, nextFirstInAtMs: T(2), nextLastOutAtMs: null })
  })

  it('externalWinsOnOut picks the LATEST OUTDOOR check-out when internal and outdoor check-outs coexist (asymmetry)', () => {
    // The internal check-out (10:30) is later than every outdoor check-out,
    // but this side's legacy branch protects the latest OUTDOOR punch (10:00).
    expect(
      applyAttendanceInOutMergePolicyPureV1(
        baseInput({
          externalWinsOnOut: true,
          recordFirstInAtMs: T(0),
          recordLastOutAtMs: T(10, 30),
          events: [
            { eventType: 'check_out', source: 'manual', occurredAtMs: T(10, 30) },
            { eventType: 'check_out', source: OUTDOOR, occurredAtMs: T(9, 50) },
            { eventType: 'check_out', source: OUTDOOR, occurredAtMs: T(10) },
          ],
        }),
      ),
    ).toEqual({ changed: true, nextFirstInAtMs: T(0), nextLastOutAtMs: T(10) })
  })

  it('externalWinsOnOut does nothing when only internal check-outs exist', () => {
    expect(
      applyAttendanceInOutMergePolicyPureV1(
        baseInput({
          externalWinsOnOut: true,
          recordFirstInAtMs: T(0),
          recordLastOutAtMs: T(10, 30),
          events: [{ eventType: 'check_out', source: 'manual', occurredAtMs: T(10, 30) }],
        }),
      ),
    ).toEqual({ changed: false, nextFirstInAtMs: T(0), nextLastOutAtMs: T(10, 30) })
  })

  it('a protected record-only last-out wins on the out side', () => {
    const protectedMs = T(11, 15)
    expect(
      applyAttendanceInOutMergePolicyPureV1(
        baseInput({
          externalWinsOnOut: true,
          recordFirstInAtMs: T(0),
          recordLastOutAtMs: T(10),
          protectedRecordLastOutAtMs: protectedMs,
          events: [{ eventType: 'check_out', source: 'manual', occurredAtMs: T(10) }],
        }),
      ),
    ).toEqual({ changed: true, nextFirstInAtMs: T(0), nextLastOutAtMs: protectedMs })
  })

  it('applies both sides independently when both flags are set', () => {
    expect(
      applyAttendanceInOutMergePolicyPureV1(
        baseInput({
          internalWinsOnIn: true,
          externalWinsOnOut: true,
          recordFirstInAtMs: T(0),
          recordLastOutAtMs: T(10, 30),
          events: [
            { eventType: 'check_in', source: OUTDOOR, occurredAtMs: T(0) },
            { eventType: 'check_in', source: 'manual', occurredAtMs: T(0, 45) },
            { eventType: 'check_out', source: 'manual', occurredAtMs: T(10, 30) },
            { eventType: 'check_out', source: OUTDOOR, occurredAtMs: T(10) },
          ],
        }),
      ),
    ).toEqual({ changed: true, nextFirstInAtMs: T(0, 45), nextLastOutAtMs: T(10) })
  })

  it('reports changed=false when the decision lands on the same instants', () => {
    expect(
      applyAttendanceInOutMergePolicyPureV1(
        baseInput({
          internalWinsOnIn: true,
          recordFirstInAtMs: T(0, 30),
          recordLastOutAtMs: T(10),
          events: [
            { eventType: 'check_in', source: OUTDOOR, occurredAtMs: T(0) },
            { eventType: 'check_in', source: 'manual', occurredAtMs: T(0, 30) },
          ],
        }),
      ),
    ).toEqual({ changed: false, nextFirstInAtMs: T(0, 30), nextLastOutAtMs: T(10) })
  })

  it('fails closed on malformed input (closed code, no partial decision)', () => {
    const cases: unknown[] = [
      null,
      baseInput({ internalWinsOnIn: 'yes' as unknown as boolean }),
      baseInput({ recordFirstInAtMs: Number.NaN }),
      baseInput({
        events: [{ eventType: 'check_inout', source: 'manual', occurredAtMs: T(0) }] as never,
      }),
      baseInput({ events: [{ eventType: 'check_in', source: '', occurredAtMs: T(0) }] }),
      baseInput({
        events: [{ eventType: 'check_in', source: 'manual', occurredAtMs: '09:00' }] as never,
      }),
    ]
    for (const input of cases) {
      expect(() =>
        applyAttendanceInOutMergePolicyPureV1(input as AttendanceFrozenMergePolicyInputV1),
      ).toThrowError(AttendanceW4MergePolicyError)
      try {
        applyAttendanceInOutMergePolicyPureV1(input as AttendanceFrozenMergePolicyInputV1)
      } catch (error) {
        expect((error as AttendanceW4MergePolicyError).code).toBe('W4C1_MERGE_POLICY_INPUT_INVALID')
      }
    }
  })
})
