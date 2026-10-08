/**
 * W7-0 (#4556) — frozen-context v2 contract-preview validator: accept legs
 * ({v1-legacy, v2-legacy, v2-group_effective}) and fail-closed reject legs
 * (unknown selector / unknown schemaVersion / v2-shape-with-v1-tag /
 * calculationGroupId-selector mismatch, per design-lock W7-R5). Also the
 * exact-key closure legs (extra key / missing key).
 *
 * Every reject fixture below differs from a VALID baseline by exactly ONE
 * field — required for the mutation self-check recorded in the PR body to
 * be meaningful (a two-defect fixture would stay red under either guard's
 * removal, making mutation "load-bearing" look true when it isn't). That
 * single-field discipline does NOT mean every leg maps to exactly one
 * guard, though: guards 2/3/4/5/6 in
 * `validateFrozenAttendanceContextV7DraftV1` are each sole coverage for
 * their own leg (verified by mutation — see the PR body's mutation table),
 * but guard 1 (exact-key closure) is sole coverage for the "extra key" leg
 * and the null/undefined non-object-input legs, while its "missing key"
 * leg is independently caught by the downstream field-level checks too
 * (deleting `timezone` still fails `isNonEmptyStringV1(ctx.timezone)` even
 * with guard 1 disabled) — defense-in-depth on that one leg, recorded
 * honestly rather than folded into a uniform claim.
 *
 * This module is not imported by any production path (W7-R9 byte-inert).
 * Deleting both files leaves every other suite green; v1's own golden test
 * (`w4c1-fingerprint-golden.test.ts`) is untouched by this PR.
 */
import { describe, expect, it } from 'vitest'
import { validateFrozenAttendanceContextV7DraftV1 } from '../w7-frozen-context-v2-contract'

function segment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    index: 0,
    startTime: '09:00',
    endTime: '18:00',
    startDayOffset: 0,
    endDayOffset: 0,
    lateGraceMinutes: 5,
    earlyLeaveGraceMinutes: 5,
    ...overrides,
  }
}

function baseFields() {
  return {
    orgId: 'org-w7-0',
    userId: 'user-w7-0',
    workDate: '2026-08-13',
    timezone: 'Asia/Shanghai',
    shiftId: 'shift-w7-0',
    isWorkday: true,
    holidayKind: null,
    roundingMinutes: 15,
    severeLateThresholdMinutes: 45,
    absenceLateThresholdMinutes: 90,
    segments: [segment()],
  }
}

function validV1Legacy() {
  return {
    schemaVersion: 1,
    selector: 'legacy',
    calculationGroupId: null,
    ...baseFields(),
  }
}

function validV2Legacy() {
  return {
    schemaVersion: 2,
    selector: 'legacy',
    calculationGroupId: null,
    ...baseFields(),
  }
}

function validV2GroupEffective() {
  return {
    schemaVersion: 2,
    selector: 'group_effective',
    calculationGroupId: 'calc-group-w7-0',
    ...baseFields(),
  }
}

describe('W7-0 frozen-context v2 contract: accept legs', () => {
  it('accepts v1-legacy', () => {
    expect(validateFrozenAttendanceContextV7DraftV1(validV1Legacy())).toBe(true)
  })

  it('accepts v2-legacy', () => {
    expect(validateFrozenAttendanceContextV7DraftV1(validV2Legacy())).toBe(true)
  })

  it('accepts v2-group_effective', () => {
    expect(validateFrozenAttendanceContextV7DraftV1(validV2GroupEffective())).toBe(true)
  })
})

describe('W7-0 frozen-context v2 contract: fail-closed reject legs (single-field mutations from a valid baseline)', () => {
  it('rejects unknown schemaVersion (2 -> 3, single field changed on the v2-legacy baseline)', () => {
    const invalid = { ...validV2Legacy(), schemaVersion: 3 }
    expect(validateFrozenAttendanceContextV7DraftV1(invalid)).toBe(false)
  })

  it('rejects unknown selector (single field changed on the v2-legacy baseline)', () => {
    const invalid = { ...validV2Legacy(), selector: 'bogus_selector' }
    expect(validateFrozenAttendanceContextV7DraftV1(invalid)).toBe(false)
  })

  it('rejects v2-shape-with-v1-tag (schemaVersion 2 -> 1, single field changed on the v2-group_effective baseline; selector+calculationGroupId stay group_effective/non-null)', () => {
    const invalid = { ...validV2GroupEffective(), schemaVersion: 1 }
    expect(validateFrozenAttendanceContextV7DraftV1(invalid)).toBe(false)
  })

  it('rejects calculationGroupId non-null while selector=legacy (single field changed on the v2-legacy baseline)', () => {
    const invalid = { ...validV2Legacy(), calculationGroupId: 'should-not-be-set' }
    expect(validateFrozenAttendanceContextV7DraftV1(invalid)).toBe(false)
  })

  it('rejects calculationGroupId null while selector=group_effective (single field changed on the v2-group_effective baseline)', () => {
    const invalid = { ...validV2GroupEffective(), calculationGroupId: null }
    expect(validateFrozenAttendanceContextV7DraftV1(invalid)).toBe(false)
  })
})

describe('W7-0 frozen-context v2 contract: exact-key closure legs (W7-R5 "exact-key fail-closed")', () => {
  it('rejects an extra unrecognized key (single field added to the v2-legacy baseline)', () => {
    const invalid = { ...validV2Legacy(), unknownField: 'x' }
    expect(validateFrozenAttendanceContextV7DraftV1(invalid)).toBe(false)
  })

  it('rejects a missing required key (single field removed from the v2-legacy baseline)', () => {
    const invalid = validV2Legacy() as Record<string, unknown>
    delete invalid.timezone
    expect(validateFrozenAttendanceContextV7DraftV1(invalid)).toBe(false)
  })
})

describe('W7-0 frozen-context v2 contract: non-object inputs', () => {
  it.each([null, undefined, 'string', 42, [], true])('rejects non-object input %p', (input) => {
    expect(validateFrozenAttendanceContextV7DraftV1(input)).toBe(false)
  })
})
