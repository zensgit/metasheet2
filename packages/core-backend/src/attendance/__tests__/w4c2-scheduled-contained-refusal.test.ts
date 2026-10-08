/**
 * W4C-2 Gate D3 (#4556 / #4844) — the scheduled per-target CONTAINMENT predicate, walked
 * MECHANICALLY over its own membership table.
 *
 * WHAT IS ACTUALLY AT STAKE. `isAttendanceScheduledContainedRefusalV1` decides, for every error the
 * authoritative `scheduled` writer branch can throw, whether the batch RECORDS a terminal `'failed'`
 * outcome for that one target and continues, or ABORTS so recovery/resume re-attempts it. Getting it
 * too WIDE burns a transient failure terminally (resume never re-loops a target that already has an
 * outcome row); getting it too NARROW turns one refused target into a dead batch. Both directions
 * are pinned here.
 *
 * WHY TABLE-DRIVEN RATHER THAN A LIST OF HAND-WRITTEN CASES. The predicate's membership authority is
 * ONE exported frozen table. The positive walk below iterates THAT table, so adding a class to it
 * automatically extends the proof instead of silently widening an undescribed predicate. The
 * counterpart risk — the table being emptied, which would make a `.some(...)` walk vacuously green —
 * is closed by the non-vacuity assertions on the table itself.
 *
 * WHY IDENTITY AND NOT `.name`. `plugins/plugin-attendance/index.cjs` dispatches on `error.name`
 * ONLY because that call site crosses a CJS/ESM module-loading boundary where constructor identity
 * is not shared. Inside this package the identity IS available, and `.name` is a plain writable
 * property — so an object literal can forge it. The impostor case below is the probe that the
 * predicate never degrades into name matching.
 *
 * No-DB, no fixtures: this runs in the ungated `src/attendance/__tests__` set.
 */
import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_W4C2_SCHEDULED_CONTAINED_REFUSAL_CLASSES_V1,
  AttendanceW4LiveScheduledBoundaryError,
  isAttendanceScheduledContainedRefusalV1,
} from '../w4c2-live-scheduled-boundary'
import { AttendanceW4AuthoritativeCalculationError } from '../w4c2-authoritative-calculation-core'
import { AttendanceW4OpsRetirementError } from '../w4c3c-ops-retirement'
import { AttendanceW4OperationError } from '../w4c0-operation-contract'

/** Both member classes share the `(code, httpStatus)` constructor shape. */
type RefusalClassCtor = new (code: string, httpStatus?: number) => Error

describe('W4C-2 Gate D3 — scheduled contained-refusal predicate', () => {
  const TABLE = ATTENDANCE_W4C2_SCHEDULED_CONTAINED_REFUSAL_CLASSES_V1

  it('the membership table is non-empty, frozen, and holds exactly the two classes D3 declares — a silently emptied table would make the walk below vacuous', () => {
    expect(TABLE.length).toBeGreaterThan(0)
    expect(Object.isFrozen(TABLE)).toBe(true)
    // Identity, not names: this is the assertion that reds if a class is dropped from the table.
    expect([...TABLE]).toEqual([
      AttendanceW4AuthoritativeCalculationError,
      AttendanceW4OpsRetirementError,
    ])
  })

  // PER-CLASS POSITIVE WALK. One `it` per table entry, generated from the table itself, so a class
  // added to the table gets its own leg with no edit here and a class removed loses its leg loudly.
  for (const cls of TABLE) {
    it(`contains a product-coded ${cls.name} instance (table entry walked)`, () => {
      const instance = new (cls as unknown as RefusalClassCtor)('PROBE_CONTAINED_CODE', 409)
      expect(instance).toBeInstanceOf(cls)
      expect(isAttendanceScheduledContainedRefusalV1(instance)).toBe(true)
    })

    it(`does NOT contain a ${cls.name} instance whose \`code\` has been stripped — membership needs a product code, not just class identity`, () => {
      const instance = new (cls as unknown as RefusalClassCtor)('PROBE_CONTAINED_CODE', 409)
      // The (a) half of the predicate. This is the case that reds when the `code` check is deleted.
      Object.defineProperty(instance, 'code', { value: undefined, configurable: true })
      expect(instance).toBeInstanceOf(cls)
      expect(isAttendanceScheduledContainedRefusalV1(instance)).toBe(false)
      // An empty-string code is equally not a product code.
      Object.defineProperty(instance, 'code', { value: '', configurable: true })
      expect(isAttendanceScheduledContainedRefusalV1(instance)).toBe(false)
    })
  }

  it('the real refusals the D3 writer branch can raise are contained — the two ops-retirement 409s and a representative core code', () => {
    // These are the codes the branch actually reaches: the guard's two terminal 409s, and the D1
    // core's closed enumeration (one representative; the class, not the string, is what decides).
    expect(
      isAttendanceScheduledContainedRefusalV1(
        new AttendanceW4OpsRetirementError('ATTENDANCE_RECORD_OPERATOR_RETIRED', 409),
      ),
    ).toBe(true)
    expect(
      isAttendanceScheduledContainedRefusalV1(
        new AttendanceW4OpsRetirementError('ATTENDANCE_RECORD_RETIRED', 409),
      ),
    ).toBe(true)
    expect(
      isAttendanceScheduledContainedRefusalV1(
        new AttendanceW4AuthoritativeCalculationError(
          'ATTENDANCE_W4_AUTH_CALC_EXPECTED_COUNT_INVALID',
          422,
        ),
      ),
    ).toBe(true)
    // Deliberate over-breadth, recorded rather than left implicit: the ops-retirement class also
    // carries codes the D3 branch cannot reach today. Containing by CLASS covers them, which fails
    // toward "one target marked failed, batch continues" rather than "the whole batch aborts".
    expect(
      isAttendanceScheduledContainedRefusalV1(
        new AttendanceW4OpsRetirementError('W4C3C_OPS_RETIREMENT_REPLAY_CONFLICT', 409),
      ),
    ).toBe(true)
  })

  it('does NOT contain the boundary error class — `W4C2_AUTHORITATIVE_PARENT_UNRESOLVED` (500) must ABORT so resume re-attempts the target', () => {
    const boundaryError = new AttendanceW4LiveScheduledBoundaryError(
      'W4C2_AUTHORITATIVE_PARENT_UNRESOLVED',
      500,
    )
    // It IS product-coded, so this proves the class table (b) half discriminates, not the code (a)
    // half: a predicate that only checked for a non-empty `code` would wrongly contain this.
    expect(typeof boundaryError.code).toBe('string')
    expect(boundaryError.code.length).toBeGreaterThan(0)
    expect(isAttendanceScheduledContainedRefusalV1(boundaryError)).toBe(false)
  })

  it('does NOT contain the operation error class — org suspension is run-wide, not a per-target outcome', () => {
    const suspended = new AttendanceW4OperationError('SEGMENT_CALCULATION_SUSPENDED')
    expect(typeof suspended.code).toBe('string')
    expect(isAttendanceScheduledContainedRefusalV1(suspended)).toBe(false)
  })

  it('does NOT contain untyped or forged shapes — bare Error, plain object, impostor `name`, and non-objects', () => {
    // A bare Error: no product code, no class membership.
    expect(isAttendanceScheduledContainedRefusalV1(new Error('boom'))).toBe(false)
    // A raw pg-shaped error carrying a SQLSTATE in `code`: product-coded by the (a) test, but not a
    // member class — 40001/40P01 belong to the two retry layers, everything else aborts.
    const pgLike = Object.assign(new Error('serialization failure'), { code: '40001' })
    expect(isAttendanceScheduledContainedRefusalV1(pgLike)).toBe(false)
    // A plain object literal with a code.
    expect(isAttendanceScheduledContainedRefusalV1({ code: 'X' })).toBe(false)
    // THE IMPOSTOR. Forges the `name` of a member class AND carries a real product code. A
    // `.name`-based predicate would contain this; an identity-based one must not.
    const impostor = {
      name: 'AttendanceW4AuthoritativeCalculationError',
      code: 'ATTENDANCE_W4_AUTH_CALC_PREIMAGE_INVALID',
      message: 'ATTENDANCE_W4_AUTH_CALC_PREIMAGE_INVALID',
    }
    expect(impostor.name).toBe(AttendanceW4AuthoritativeCalculationError.name)
    expect(isAttendanceScheduledContainedRefusalV1(impostor)).toBe(false)
    // Same forgery on a real Error instance, so "it wasn't an Error" cannot be the reason it failed.
    const impostorError = Object.assign(new Error('x'), {
      name: 'AttendanceW4OpsRetirementError',
      code: 'ATTENDANCE_RECORD_RETIRED',
    })
    expect(isAttendanceScheduledContainedRefusalV1(impostorError)).toBe(false)
    // Non-objects.
    expect(isAttendanceScheduledContainedRefusalV1(null)).toBe(false)
    expect(isAttendanceScheduledContainedRefusalV1(undefined)).toBe(false)
    expect(isAttendanceScheduledContainedRefusalV1('ATTENDANCE_RECORD_RETIRED')).toBe(false)
    expect(isAttendanceScheduledContainedRefusalV1(409)).toBe(false)
  })
})
