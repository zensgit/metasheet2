import { describe, expect, it } from 'vitest'

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceBonusPolicyForTests as {
  normalizeAttendanceBonusPolicySetting: (raw: unknown) => {
    enabled: boolean
    anyLeaveBreaksFullAttendance: boolean
    lateBeyondThresholdBreaksFullAttendance: boolean
  }
  resolveFullAttendanceEligible: (
    summary: Record<string, unknown>,
    policy: { enabled?: boolean; anyLeaveBreaksFullAttendance?: boolean; lateBeyondThresholdBreaksFullAttendance?: boolean } | undefined,
  ) => boolean | null
}

describe('#加班银行 v1-3a — AttendanceBonusPolicy normalizer (LATENT, 满勤)', () => {
  const norm = helpers.normalizeAttendanceBonusPolicySetting

  it('default dormant: OFF, but the 满勤-breaking toggles default ON (§3 口径)', () => {
    const d = { enabled: false, anyLeaveBreaksFullAttendance: true, lateBeyondThresholdBreaksFullAttendance: true }
    expect(norm(undefined)).toEqual(d)
    expect(norm({})).toEqual(d)
    expect(norm('x')).toEqual(d)
  })

  it('toggles are settable; a customer can relax late-breaks but keep leave-breaks', () => {
    expect(norm({ enabled: true, lateBeyondThresholdBreaksFullAttendance: false })).toEqual({
      enabled: true, anyLeaveBreaksFullAttendance: true, lateBeyondThresholdBreaksFullAttendance: false,
    })
    expect(norm({ enabled: true, anyLeaveBreaksFullAttendance: false })).toEqual({
      enabled: true, anyLeaveBreaksFullAttendance: false, lateBeyondThresholdBreaksFullAttendance: true,
    })
  })
})

describe('#加班银行 v1-3b — resolveFullAttendanceEligible (满勤 compute, dormant / §4 即便被池抵掉)', () => {
  const f = helpers.resolveFullAttendanceEligible
  const ON = { enabled: true, anyLeaveBreaksFullAttendance: true, lateBeyondThresholdBreaksFullAttendance: true }

  it('DORMANT: policy off / missing → null (no flag → the summary response stays byte-identical)', () => {
    expect(f({ leave_minutes: 0, late_days: 0, early_leave_days: 0 }, undefined)).toBeNull()
    expect(f({ leave_minutes: 0 }, { enabled: false, anyLeaveBreaksFullAttendance: true, lateBeyondThresholdBreaksFullAttendance: true })).toBeNull()
  })

  it('clean period (no leave, no late/early) → true', () => {
    expect(f({ leave_minutes: 0, late_days: 0, early_leave_days: 0 }, ON)).toBe(true)
  })

  it('§4 DISCRIMINATOR: ANY leave → false EVEN IF fully offset by the comp-time pool (reads RAW leave_minutes)', () => {
    // leave_minutes = Σ approved leave requests (pre-offset); a leave fully offset by the bank still has it > 0.
    expect(f({ leave_minutes: 480, late_days: 0, early_leave_days: 0 }, ON)).toBe(false)
  })

  it('a late or early-leave day → false (when lateBeyondThresholdBreaksFullAttendance is on)', () => {
    expect(f({ leave_minutes: 0, late_days: 1, early_leave_days: 0 }, ON)).toBe(false)
    expect(f({ leave_minutes: 0, late_days: 0, early_leave_days: 1 }, ON)).toBe(false)
    // §P1 (owner review): late_early is a SEPARATE status (same-day both late AND early) — it must also break
    // 满勤, not slip through late_days/early_leave_days both being 0.
    expect(f({ leave_minutes: 0, late_days: 0, early_leave_days: 0, late_early_days: 1 }, ON)).toBe(false)
  })

  it('toggles relax the breaks independently', () => {
    const leaveOk = { enabled: true, anyLeaveBreaksFullAttendance: false, lateBeyondThresholdBreaksFullAttendance: true }
    expect(f({ leave_minutes: 480, late_days: 0, early_leave_days: 0 }, leaveOk)).toBe(true)   // leave relaxed
    expect(f({ leave_minutes: 480, late_days: 1, early_leave_days: 0 }, leaveOk)).toBe(false)  // but late still breaks
    const lateOk = { enabled: true, anyLeaveBreaksFullAttendance: true, lateBeyondThresholdBreaksFullAttendance: false }
    expect(f({ leave_minutes: 0, late_days: 3, early_leave_days: 2 }, lateOk)).toBe(true)      // late relaxed
    expect(f({ leave_minutes: 60, late_days: 0, early_leave_days: 0 }, lateOk)).toBe(false)    // but leave still breaks
  })
})
