/**
 * W7-2 (#4556) — §3.1 arm-state partition legs (brief matrix T-A3 static half
 * + T-A4).
 *
 * Authority: #4556 comments 5293034619 + 5293478713; design lock §4.2.
 *
 * The behavioural halves (the dual-run actually running, byte parity, the
 * group arm still replacing under `group_authoritative`) live in the real-DB
 * suites; these legs pin the STATIC partition the seam derives its branch
 * from, so a sixth state, a double-bucketed state, or a widened group-arm
 * array reds without a database.
 */
import { describe, it, expect } from 'vitest'
import { ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1 } from '../../src/attendance/w7-context-source-posture-contract'
import {
  ATTENDANCE_W7_GROUP_ARM_STATES_V1,
  ATTENDANCE_W7_SHADOW_COMPARE_STATES_V1,
  ATTENDANCE_W7_BLOCKED_ARM_STATES_V1,
  attendanceW7PostureSelectsGroupArmV1,
  attendanceW7PostureSelectsShadowCompareV1,
  assertAttendanceW7ArmStatePartitionV1,
} from '../../src/attendance/w7-resolver/w7-frozen-context-issuance-seam'

describe('W7-2 §3.1 — seam arm-state partition', () => {
  it('T-A3 (static half): the group-arm array is UNCHANGED — group_authoritative only, served group arm', () => {
    expect([...ATTENDANCE_W7_GROUP_ARM_STATES_V1]).toEqual(['group_authoritative'])
    expect(attendanceW7PostureSelectsGroupArmV1('group_authoritative')).toBe(true)
    // The shadow-compare states must NOT select the served group arm — adding
    // either to the group-arm array is the W7-R3 violation this leg guards.
    expect(attendanceW7PostureSelectsGroupArmV1('group_shadow')).toBe(false)
    expect(attendanceW7PostureSelectsGroupArmV1('group_eligible')).toBe(false)
    expect(attendanceW7PostureSelectsGroupArmV1('off')).toBe(false)
    expect(attendanceW7PostureSelectsGroupArmV1('suspended')).toBe(false)
  })

  it('the shadow-compare set is exactly {group_shadow, group_eligible} — group_eligible per [OWNER-CONFIRM B-3, OPEN] recommended reading', () => {
    expect([...ATTENDANCE_W7_SHADOW_COMPARE_STATES_V1]).toEqual(['group_shadow', 'group_eligible'])
    expect(attendanceW7PostureSelectsShadowCompareV1('group_shadow')).toBe(true)
    expect(attendanceW7PostureSelectsShadowCompareV1('group_eligible')).toBe(true)
    expect(attendanceW7PostureSelectsShadowCompareV1('group_authoritative')).toBe(false)
    expect(attendanceW7PostureSelectsShadowCompareV1('off')).toBe(false)
    expect(attendanceW7PostureSelectsShadowCompareV1('suspended')).toBe(false)
  })

  it('T-A4: group-arm ∪ shadow-compare ∪ blocked ∪ {off} partitions the state enumeration exactly (pairwise disjoint, derived domain)', () => {
    const union = [
      ...ATTENDANCE_W7_GROUP_ARM_STATES_V1,
      ...ATTENDANCE_W7_SHADOW_COMPARE_STATES_V1,
      ...ATTENDANCE_W7_BLOCKED_ARM_STATES_V1,
      'off',
    ]
    expect(new Set(union).size, 'pairwise disjointness').toBe(union.length)
    expect([...union].sort()).toEqual([...ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1].sort())
    // The module-load assert accepts the real derived domain (positive control
    // for the added-state leg below).
    expect(() => assertAttendanceW7ArmStatePartitionV1()).not.toThrow()
    expect(() =>
      assertAttendanceW7ArmStatePartitionV1([...ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1]),
    ).not.toThrow()
  })

  it('T-A4b (the added-state control): a sixth state with no bucket reds by construction', () => {
    const widened = [...ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1, 'group_frozen_probation']
    expect(() => assertAttendanceW7ArmStatePartitionV1(widened)).toThrowError(
      'W7_ARM_STATE_PARTITION_INVALID',
    )
  })
})
